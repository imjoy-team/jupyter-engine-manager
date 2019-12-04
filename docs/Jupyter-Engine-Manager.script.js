const DEFAULT_BASE_URL = 'https://mybinder.org'
const DEFAULT_PROVIDER = 'gh'
const DEFAULT_SPEC = 'oeway/imjoy-binder-image/master' 

const debounce = JupyterEngineManager.debounce
const ServerConnection = JupyterEngineManager.services.ServerConnection
const Kernel = JupyterEngineManager.services.Kernel
const BinderHub = JupyterEngineManager.BinderHub
const util = JupyterEngineManager.util
const baseToWsUrl = baseUrl =>
  (baseUrl.startsWith('https:') ? 'wss:' : 'ws:') +
  baseUrl
    .split(':')
    .slice(1)
    .join(':')

class JupyterServer {
  constructor() {
    // this._kernelHeartbeat = this._kernelHeartbeat.bind(this)
    this.cached_servers = {}
    this.registered_file_managers = {}
    if(localStorage.jupyter_servers){
      try{
        this.cached_servers = JSON.parse(localStorage.jupyter_servers)
        console.log('kernels loaded:', this.cached_servers)
        for(let k in this.cached_servers){
          const {url, token} = this.cached_servers[k]
          // check if the server is alive, otherwise remove it
          const serverSettings = ServerConnection.makeSettings({
            baseUrl: url,
            wsUrl: baseToWsUrl(url),
            token: token,
          })
          Kernel.getSpecs(serverSettings).catch(()=>{
            delete this.cached_servers[k]
          })
        }
      }
      catch(e){
      }
    }
    this.cached_kernels = {}
    if(localStorage.jupyter_kernels){
      try{
        this.cached_kernels = JSON.parse(localStorage.jupyter_kernels)
        console.log('kernels loaded:', this.cached_kernels)
      }
      catch(e){
      }
    }
    console.log('cached servers: ', this.cached_servers, 'cached kernels: ', this.cached_kernels)

    this._kernels = {}
    // Keep track of properties for debugging
    this.kernel = null
    this._kernelHeartbeat()
  }

  async _kernelHeartbeat(seconds_between_check = 5){
    for(let k in this.cached_kernels){
      try {
        await this._getKernel(k)
        console.log('kernel is live: ', k)
      } catch (err) {
        console.log('Looks like the kernel died:', err.toString())
        console.log('Starting a new kernel...')
        delete this.cached_kernels[k]
      }
    }
    localStorage.jupyter_kernels = JSON.stringify(this.cached_kernels)
    setTimeout(this._kernelHeartbeat, seconds_between_check * 1000)
  }

  setupKernelCallbacks(kernel){
    const _close_callbacks = []
    kernel.statusChanged.connect(() => {
      // console.log('kernel status changed', kernel.status);
      if(kernel.status === 'dead'){
        kernel.close()
      }
    });
    kernel.onClose = (handler)=>{
      _close_callbacks.push(handler);
    }
    kernel.close =() =>{
      for(let cb of _close_callbacks){
        try{
          cb()
        }
        catch(e){
          console.error(e)
        }
      }
      if(jserver._kernels[kernel.id])
      if(kernel.shutdown){
        kernel.shutdown().then(()=>{
          delete jserver._kernels[kernel.id]
        })
      }
      else{
        delete jserver._kernels[kernel.id]
      }
    }
  }

  async _getKernel(key, serverSettings_) {
    if(!this.cached_kernels[key]){
      throw "kernel not found: "+key
    }
    const { baseUrl, token, kernelId } =  this.cached_kernels[key]
    if(serverSettings_ && (baseUrl !== serverSettings_.baseUrl || token !== serverSettings_.token)){
      throw "server settings mismatch."
    }
    if(this._kernels[kernelId] && this._kernels[kernelId].status === 'idle'){
      console.log('reusing a running kernel', kernelId)
      return this._kernels[kernelId]
    }
    const { serverSettings, kernelModel } = await this._getKernelModel(baseUrl, token, kernelId)
    const kernel = await Kernel.connectTo(kernelModel, serverSettings)
    this.setupKernelCallbacks(kernel);

    if(this._kernels[kernel.id]){
      this._kernels[kernel.id].ready.then(this._kernels[kernel.id].shutdown)
    }
    this._kernels[kernel.id] = kernel
    return kernel
  }

  async _getKernelModel(baseUrl, token, kernelId) {
    const serverSettings = ServerConnection.makeSettings({
      baseUrl: baseUrl,
      wsUrl: baseToWsUrl(baseUrl),
      token: token,
    })

    const kernelModel = await Kernel.findById(kernelId, serverSettings)
    return { serverSettings, kernelModel }
  }

  async getOrStartKernel(key, serverSettings, requirements) {
    try {
      const kernel = await this._getKernel(key, serverSettings)
      console.log('Connected to cached kernel.')
      return kernel
    } catch (err) {
      console.log(
        'No cached kernel, starting kernel a new kernel:',
        err.toString(),
      )
      const kernel = await this.startKernel(key, serverSettings)
      await this.installRequirements(kernel, requirements, true);

      return kernel
    }
  }


  async startServer({
    name = null,
    spec = DEFAULT_SPEC,
    baseUrl = DEFAULT_BASE_URL,
    provider = DEFAULT_PROVIDER,
    nbUrl = false,
  } = {}){   
    let serverSettings = null;
    let server_url = null, server_token = null;
    const config_str = JSON.stringify({ name, spec, baseUrl, provider, nbUrl })
    if(this.cached_servers[config_str]){
      const {url, token} = this.cached_servers[config_str]
      server_url = url
      server_token = token
      try{
        // Connect to the notebook webserver.
        serverSettings = ServerConnection.makeSettings({
          baseUrl: url,
          wsUrl: baseToWsUrl(url),
          token: token,
        })
        const kernelSpecs = await Kernel.getSpecs(serverSettings)
        console.log('reusing an existing server: ', url, kernelSpecs)
        api.log('Connected to an existing server: ' + url)
      }
      catch(e){
        console.log('failed to reuse an existing server, will start another one.')
        delete this.cached_servers[config_str]
      }
    }

    if(!serverSettings){
      const binder = new BinderHub({ spec, baseUrl, provider, nbUrl })
      binder.registerCallback('*', (oldState, newState, data) => {
        if (data.message !== undefined) {
          api.log(data.message)
          api.showStatus(data.message)
        } else {
          console.log(data)
        }
      })
      const {url, token} = await binder.startServer()
      server_url = url
      server_token = token
      api.log('New server started: ' + url)
      this.cached_servers[config_str] = {url, token}
      localStorage.jupyter_servers = JSON.stringify(this.cached_servers)
      // Connect to the notebook webserver.
      serverSettings = ServerConnection.makeSettings({
        baseUrl: url,
        wsUrl: baseToWsUrl(url),
        token: token,
      })
    }

    if(!this.registered_file_managers[server_url]){
      const url = server_url;
      const token = server_token;
      let name = new URL(url);
      name = name.pathname === '/' ? name.hostname: name.pathname ;
      await api.register({
        type: 'file-manager',
        name: name,
        url: url,
        async listFiles(root, type, recursive){
          const file_url = `${url}api/contents/${encodeURIComponent(root)}?token=${token}`;
          const response = await fetch(file_url);
          const files = await response.json();
          files.children = files.content;
          console.log('listing files', file_url, files)
          return files
        },
        removeFiles(){
          
        },
        getFileUrl(config){
          return `${url}view/${encodeURIComponent(config.path)}?token=${token}`;
        },
        getFile(){

        },
        putFile(file){
          throw "File upload is not supported"
        },
        requestUploadUrl(config){
          console.log('generating upload url', config.path, config.dir)
          if(dir && path){
            return `${url}api/contents/${encodeURIComponent(config.dir+config.path)}?token=${token}`;
          }

          if(path){
            return `${url}api/contents/${encodeURIComponent(config.path)}?token=${token}`;
          }
        },
        async heartbeat(){
          try{
            await Kernel.getSpecs(serverSettings)
          }
          catch{
            // console.log('Removing file manager.')
            // api.unregister({
            //   type: 'file-manager',
            //   url: url
            // })
            // delete this.registered_file_managers[url]

            return false
          }
          
          return true
        }
      })
      this.registered_file_managers[url] = url;
    }

    // localStorage.serverParams = JSON.stringify({ url, token })
    return serverSettings
  }

  async startKernel(key, serverSettings, kernelSpecName) {
    try {
      // Start a kernel
      if(!kernelSpecName){
        const kernelSpecs = await Kernel.getSpecs(serverSettings)
        kernelSpecName = kernelSpecs.default
      }
      console.log('Starting kernel with spec: ' + kernelSpecName)
      const kernel = await Kernel.startNew({
        name: kernelSpecName,
        serverSettings,
      })
      this.setupKernelCallbacks(kernel);
      // Store the params in localStorage for later use
      // localStorage.kernelId = kernel.id
      if(this._kernels[kernel.id]){
        this._kernels[kernel.id].shutdown()
      }
      this._kernels[kernel.id] = kernel;
      this.cached_kernels[key] = {baseUrl: serverSettings.baseUrl, token: serverSettings.token, kernelId: kernel.id}
      localStorage.jupyter_kernels = JSON.stringify(this.cached_kernels)

      api.log('Kernel started: ' + kernel.id)
      return kernel
    } catch (err) {
      debugger
      console.error('Error in kernel initialization :(')
      throw err
    }
  }

  installRequirements(kernel, reqs, conda_available) {
    return new Promise(async (resolve, reject) => {
      const commands = [] //'!pip install --upgrade pip'
      if(!Array.isArray(reqs)){
        reqs = [reqs]
      }
      for(let req of reqs){
        if(req.includes(":")){
            const req_parts = req.split(":")
            const typ = req_parts[0].trim()
            const libs_ = req_parts.slice(1).join(":").trim()
            const libs = []
            for(let l of libs_.split(" ")){
              if(l.trim()){
                libs.push(l.trim())
              }
            }
            
            if(typ === "conda" && libs && conda_available)
                commands.push("!conda install -y " + libs.join(" "))
            else if(typ === "pip" && libs)
                commands.push("!pip install " + libs.join(" "))
            else if(typ == "repo" && libs){
              const temp = libs[0].split("/")
              const name = temp[temp.length-1].replace(".git", "")
              commands.push("!git clone --progress --depth=1 " + libs[0] + " " + (libs.length > 1 ? libs[1] : name))
            }
            else if(typ === "cmd" && libs)
                commands.push(libs.join(" "))
            else if(typ.includes("+") || typ.includes("http"))
                commands.push(`!pip install ${req}`)
            else
                throw `Unsupported requirement type: ${typ}`
        }
        else{
          commands.push(`!pip install ${req}`)
        }
      }

      let execution = kernel.requestExecute({ code: commands.join("\n") })
      api.log(`Installing requirements for kernel ${kernel.id}: ${JSON.stringify(commands)}`)
      execution.onIOPub = msg => {
        if(msg.msg_type == 'stream'){
          if(msg.content.name == 'stdout'){
            let data = msg.content.text
            data = util.fixOverwrittenChars(data);
            // escape ANSI & HTML specials in plaintext:
            data = util.fixConsole(data);
            data = util.autoLinkUrls(data);
            api.showStatus(data)
            console.log(data)
          }
        }
      }
      execution.done.then(resolve).catch(reject)
    })

  }

  async killKernel(kernel) {
    if(kernel.close) kernel.close();
    return kernel.shutdown()
  }
}

const jserver = new JupyterServer()


async function setup() {
  await api.register({
    type: 'engine-factory',
    name: 'MyBinder-Engine',
    addEngine: addMyBinderEngine,
    removeEngine: removeEngine
  })

  await api.register({
    type: 'engine-factory',
    name: 'Jupyter-Engine',
    addEngine: addJupyterEngine,
    removeEngine: removeEngine
  })

  createNewEngine({
    name: 'MyBinder Engine',
    url: DEFAULT_BASE_URL,
    spec: DEFAULT_SPEC
  })
  // let saved_engines = await api.getConfig('engines')
  // try{
  //     saved_engines = saved_engines ? JSON.parse(saved_engines) : {}
  // }
  // catch(e){
  //   saved_engines = {}
  // }
  // for(let url in saved_engines){
  //   const config = saved_engines[url]
  //   createNewEngine(config)
  // }
  api.log('initialized')
}

async function addJupyterEngine(){
  
  // Connect to the notebook webserver.
const description=`#### Jupyter Engine <sup>alpha</sup>
 
  This allows ImJoy run Python plugin via a [Jupyter notebook](https://jupyter.org/) server. The easiest way to run Jupyter notebook is by using [Anaconda](https://docs.anaconda.com/anaconda/) or [Miniconda](https://docs.conda.io/en/latest/miniconda.html) with Jupyter notebook installed.  
 
  1. Start a Jupyter notebook from your terminal (or Anaconda Prompt) with the command: <br><code>jupyter notebook --NotebookApp.allow_origin='*'</code>
  2. Copy and paste the provided URL in "Jupyter Notebook URL" below. **⚠️Important**: the URL needs to contain the connection token, e.g.: http://localhost:8888/?token=caac2d7f2e8e0...ad871fe
  3. Click "CONNECT TO JUPYTER"

**Note 1**: This feature is still in development, and new features such as file uploading and terminal will be supported soon.
**Note 2**: Due to security reasons, ImJoy cannot connect to remote notebook server served without <code>https</code>, for Chrome/Firefox, the only exception is the URL for localhost (127.0.0.1 or localhost, Safari can only be used with https URL).
`
    const dialog = await api.showDialog(
      {
        type: 'imjoy/schema-io',
        name: 'Connect to a Jupyter Engine',
        data: {
          id: 0,
          type: 'form',
          schema: {
            "fields": [
              {
                "type": "input",
                "inputType": "text",
                "label": "Engine Name",
                "model": "name",
              },
              {
                "type": "input",
                "inputType": "text",
                "label": "Jupyter Notebook URL",
                "hint": "A Jupyter notebook server url with token, e.g.: http://localhost:8888/?token=caac2d7f2e8e0...ad871fe",
                "model": "nbUrl",
              }
            ]
          },
          data: {nbUrl: '', name: 'Jupyter Notebook'},
          options: {
              validateAfterLoad: true,
              validateAfterChanged: true
          },
          description: description,
          buttons: [{label: 'Connect to Jupyter', event_id: 'add', class: 'md-primary md-raised'}]
        }
    })
    dialog.on('add', async (config)=>{
      dialog.close()
      createNewEngine(config)
      // let saved_engines = await api.getConfig('engines')
      // try{
      //   saved_engines = saved_engines ? JSON.parse(saved_engines) : {}
      // }
      // catch(e){
      //   saved_engines = {}
      // }
      // saved_engines[config.url] = config
      // await api.setConfig('engines', JSON.stringify(saved_engines))

    })
}


async function addMyBinderEngine(){
  
  // Connect to the notebook webserver.
const description=`### MyBinder Engine <sup>alpha</sup>
  You can run Python plugin in ImJoy via free Jupyter servers provided by [MyBinder.org](https://mybinder.org). 
  This engine runs remotely, so no local installation or setup is required. 
  However, the provided computation power is limited (e.g. only 1GB memory and no GPU support).

  To add a new MyBinder Engine, you can keep the default settings below and click "START ANOTHER BINDER ENGINE".
  To reduce the startup time, you can specify plugin specific <code>Specification</code> repository on Github according to [here](https://mybinder.readthedocs.io/en/latest/config_files.html#config-files). 

⚠️Note 1: This feature is still in development, and new features such as file uploading and terminal will be supported soon.
⚠️Note 2: You should **never** process sensitive data with MyBinder Engine ([more information](https://mybinder.readthedocs.io/en/latest/faq.html#how-secure-is-mybinder-org)).
`
    const dialog = await api.showDialog(
      {
        type: 'imjoy/schema-io',
        name: 'Start Another MyBinder Engine',
        data: {
          id: 0,
          type: 'form',
          schema: {
            "fields": [
              {
                "type": "input",
                "inputType": "text",
                "label": "Engine Name",
                "model": "name",
              },
              {
                "type": "input",
                "inputType": "text",
                "label": "Specification",
                "hint": "A github repo with configuration files, format: GITHUB_USER/GITHUB_REPO/BRANCH",
                "model": "spec",
              },
              {
                "type": "input",
                "inputType": "text",
                "label": "Binder URL",
                "model": "url",
              }
            ]
          },
          data: {
            name: 'New Binder Engine',
            url: DEFAULT_BASE_URL,
            spec: DEFAULT_SPEC
          },
          options: {
              validateAfterLoad: true,
              validateAfterChanged: true
          },
          description: description,
          buttons: [{label: 'Start another Binder Engine', event_id: 'add', class: 'md-primary md-raised'}]
        }
    })
    dialog.on('add', async (config)=>{
      dialog.close()
      createNewEngine(config)
    })
}

function randId() {
  return Math.random()
    .toString(36)
    .substr(2, 10);
}

class JupyterConnection {
  constructor(id, type, config, kernel) {
    this._disconnected = false;
    this.id = id;
    this._initHandler = () => {};
    this._failHandler = () => {};
    this._disconnectHandler = () => {};
    this._loggingHandler = () => {};
    this.kernel = kernel;

    const config_ = {
      api_version: config.api_version,
      flags: config.flags,
      tag: config.tag,
      workspace: config.workspace,
      env: config.env,
      requirements: config.requirements,
      cmd: config.cmd,
      name: config.name,
      type: config.type,
      inputs: config.inputs,
      outputs: config.outputs,
    };

    console.log('init_plugin...', config)

    this.prepare_kernel(kernel, id).then((comm)=>{
      console.log('kernel prepared...')
      this.initializing = false;
      this._disconnected = false;
      this.comm = comm;
      comm.onMsg = msg => {
          var data = msg.content.data
          if (["initialized",
              "importSuccess",
              "importFailure",
              "executeSuccess",
              "executeFailure"
              ].includes(data.type)) {
              this.handle_data_message(data)
          } else {
              this.handle_data_message({ type: 'message', data: data })
          }
      }

      comm.onClose = msg => {
        debugger;
        console.log('comm closed, reconnecting', id, msg);
        this.reconnect()
      };

      this.dedicatedThread = true;
      this._initHandler();
    
    }).catch(()=>{
      this._disconnected = true;
      console.error("failed to initialize plugin on the plugin engine");
      this._failHandler("failed to initialize plugin on the plugin engine");
      throw "failed to initialize plugin on the plugin engine";
    })
  }

  handle_data_message(data){
    if (data.type == "initialized") {
      this.dedicatedThread = data.dedicatedThread;
      this._initHandler();
    } 
    else if (data.type == "logging") {
      this._loggingHandler(data.details);
    } else if (data.type == "disconnected") {
      this._disconnectHandler(data.details);
    }
    else{
        switch (data.type) {
        case "message":
          data = data.data
          // console.log('message_from_plugin_'+this.secret, data)
          if (data.type == "initialized") {
            this.dedicatedThread = data.dedicatedThread;
            this._initHandler();
          } else if (data.type == "logging") {
            this._loggingHandler(data.details);
          } else if (data.type == "disconnected") {
            this._disconnectHandler(data.details);
          } else {
            this._messageHandler(data);
          }
          break;
        // case "importSuccess":
        //   this._handleImportSuccess(m.url);
        //   break;
        // case "importFailure":
        //   this._handleImportFailure(m.url, m.error);
        //   break;
        case "executeSuccess":
          this._executeSCb();
          break;
        case "executeFailure":
          this._executeFCb(data.error);
          break;
      }
    }
  }

  prepare_kernel(kernel, plugin_id) {
    return new Promise(async (resolve, reject) => {
      console.log('installing imjoy...')
      api.showStatus('Setting up ImJoy worker...')
      let execution = kernel.requestExecute({ code: '!pip install -U imjoy' })
      console.log(kernel, execution)
      execution.onIOPub = msg => {
        if(msg.msg_type == 'stream'){
          if(msg.content.name == 'stdout'){
            api.showStatus(msg.content.text)
          }
        }
      }
      const client_id = plugin_id;
      execution.done.then(()=>{
        console.log('starting jupyter client ...', client_id)
        kernel.requestExecute({ code: `from imjoy.workers.jupyter_client import JupyterClient;JupyterClient.recover_client("${client_id}")` }).done.then(()=>{
          kernel.registerCommTarget(
              'imjoy_comm_' + client_id,
              function (comm, open_msg) {

                //var config = open_msg.content.data
                //pio.emit("message_from_plugin_" + id, {'type': 'init_plugin', 'id': config.id, 'config': config});       
                resolve(comm)
              }
          )
          console.log('connecting ImJoy worker...')
          const command = `from imjoy.workers.python_worker import PluginConnection as __plugin_connection__;__plugin_connection__.add_plugin("${plugin_id}", "${client_id}").start()`;
          execution = kernel.requestExecute({ code: command })
          execution.onIOPub = msg => {
            if(msg.msg_type == 'stream'){
              if(msg.content.name == 'stdout'){
                api.showStatus(msg.content.text)
              }
            }
          }
          execution.done.then(()=>{
            api.showStatus('ImJoy worker is ready.')
            console.log('ImJoy worker connected...')
          }).catch(reject);  
        })
      });
    });
  }

  reconnect() {
    return new Promise((resolve, reject) => {
      console.log('reconnecting kernel...', this.kernel)
      this.kernel.reconnect().then(()=>{
        console.log('kernel reconnected')
        this.comm = this.kernel.connectToComm('imjoy_comm_' + this.id);
        console.log('comm reconnected')
        resolve(this.comm)
      }).catch((e)=>{
        console.log('failed to reconnect kernel ', e)
        // setTimeout(()=>{this.reconnect().then(resolve)}, 5000)
      })
    })
  }

  send(data) {
    if (this.kernel.status !== 'dead' && this.comm && !this.comm.isDisposed) {
      //console.log('message to plugin', this.secret,  data)
      this.comm.send({
        type: "message",
        data: data,
      });
    } else {
      this.reconnect().then(()=>{
        this.comm.send({
          type: "message",
          data: data,
        });
      })
    }
  }

  execute(code) {
    return new Promise((resolve, reject) => {
      this._executeSCb = resolve;
      this._executeFCb = reject;
      this.send({ type: "execute", code: code });
    });
  }

  disconnect() {
    if (!this._disconnected) {
      this._disconnected = true;
    }
    if(this._disconnectHandler) this._disconnectHandler();

    if(this.kernel) {
      console.log('shutting don kernel: ', this.kernel.id)
      jserver.killKernel(this.kernel)
      this.kernel = null;
    };
  }

  onMessage(handler) {
    this._messageHandler = handler;
  }

  onDisconnect(handler) {
    this._disconnectHandler = handler;
  }

  onLogging(handler) {
    this._loggingHandler = handler;
  }

  onInit(handler) {
    this._initHandler = handler;
  }

  onFailed(handler) {
    this._failHandler = handler;
  }
}

async function createNewEngine(engine_config){
  await api.register({
    type: 'engine',
    pluginType: 'native-python',
    icon: '🚀',
    name: engine_config.name,
    url: 'http://mybinder.org',
    config: engine_config,
    connect(){
      // return engine.connect();
    },
    disconnect(){
      // return engine.disconnect();
    },
    listPlugins: ()=>{
    },
    getPlugin: ()=>{
    },
    startPlugin: (config, interface)=>{
      return new Promise(async (resolve, reject) => {
        let serverSettings, kernelSpecName=null;
        if(engine_config.nbUrl){
          serverSettings = await jserver.startServer(engine_config)
        }
        else{
          if(!jserver.binder_confirmation_shown){
            const ret = await api.confirm({title: "📌Notice: About to run plugin on mybinder.org", content: `You are going to run <code>${config.name}</code> on a public cloud server provided by <a href="https://mybinder.org" target="_blank">MyBinder.org</a>, please be aware of the following: <br><br> 1. This feature is currently in development, more improvements will come soon; <br> 2. The computational resources provided by MyBinder.org are limited (e.g. 1GB memory, no GPU support); <br>3. Please do not use it to process sensitive data. <br><br> For more stable use, please setup your own <a href="https://jupyter.org/" target="_blank">Jupyter notebook</a> or use the <a href="https://imjoy.io/docs/#/user_manual?id=plugin-engine" target="_blank">ImJoy-Engine</a> for now. <br> <br> If you encountered any issue, please report it on the <a href="https://github.com/oeway/ImJoy/issues" target="_blank">ImJoy repo</a>. <br><br> Do you want to continue?`, confirm_text: 'Yes'})
            if(!ret){
              reject("User canceled plugin execution.")
              return
            }
            jserver.binder_confirmation_shown = true
          }
          
          if(interface.TAG && interface.TAG.includes('GPU')){
            const ret = await api.confirm({title: "📌Running plugin that requires GPU?", content: `It seems you are trying to run a plugin with GPU tag, however, please notice that the server on MyBinder.org does NOT support GPU. <br><br> Do you want to continue?`, confirm_text: 'Yes'})
            if(!ret){
              reject("User canceled plugin execution.")
              return
            }
          }
          let binderSpec = DEFAULT_SPEC;
          if(Array.isArray(config.env)){
            for(let e of config.env){
              if(e.type === 'binder' && e.spec){
                binderSpec = e.spec
                kernelSpecName = e.kernel
              }
            }
          }
          console.log('Starting server with binder spec', binderSpec)
          engine_config.spec = binderSpec;
          serverSettings = await jserver.startServer(engine_config);
        }
        
        api.showMessage('🎉 Connected to Jupyter server: ' + serverSettings.baseUrl)
        
        const kernel = await jserver.startKernel(config.name, serverSettings, kernelSpecName)
        await jserver.installRequirements(kernel, config.requirements, true);
        kernel.pluginId = config.id;
        kernel.pluginName = config.name;
        kernel.onClose(()=>{
          config.terminate()
        })
        // const kernel = await jserver.getOrStartKernel(config.name, serverSettings, config.requirements);
        // kernel.statusChanged.connect(status => {
        //   console.log('kernel status changed', kernel._id, status);
        // });
        console.log('Kernel started:', kernel._id, config.name, kernel)        
        const connection = new JupyterConnection(config.id, 'native-python', config, kernel);
        connection.onInit(()=>{
          const site = new JailedSite(connection, "__plugin__", "javascript");
          site.onInterfaceSetAsRemote(async ()=>{
            api.showStatus('Executing plugin script for ' + config.name + '...')
            for (let i = 0; i < config.scripts.length; i++) {
              await connection.execute({
                type: "script",
                content: config.scripts[i].content,
                lang: config.scripts[i].attrs.lang,
                attrs: config.scripts[i].attrs,
                src: config.scripts[i].attrs.src,
              });
            }
            site.onRemoteUpdate(() => {
              const remote_api = site.getRemote();
              console.log(`plugin ${config.name} (id=${config.id}) initialized.`, remote_api)
              api.showStatus(`🎉Plugin "${config.name}" is ready.`)
              resolve(remote_api)
              site.onDisconnect((details) => {
                config.terminate()
              })
            });
            site.requestRemote();
          });
          site.onDisconnect((details) => {
            console.log('disconnected.', details)
            connection.disconnect()
            reject('disconnected')
          })
          site.setInterface(interface);
        })

      });
    },
    getEngineInfo() {
      return {}
      // return engine.engine_info;
    },
    async getEngineStatus() {
      const kernels_info = []
      for(let k in jserver._kernels){
        const kernel = jserver._kernels[k]
        kernels_info.push({name: kernel.pluginName || kernel.name, pid: kernel.id})
      }
      // for(let k in jserver.cached_servers){
      //   const {url, token} = jserver.cached_servers[k]
      //   // Connect to the notebook webserver.
      //   const serverSettings = ServerConnection.makeSettings({
      //     baseUrl: url,
      //     wsUrl: baseToWsUrl(url),
      //     token: token,
      //   })
      //   try{
      //     const kernels = await Kernel.listRunning(serverSettings)
      //     for(let kernel of kernels){
      //       kernels_info.push({name: kernel.name, pid: kernel.id})
      //     }
      //   }
      //   catch(e){
      //     console.error('removing dead server:', e)
      //   }
      // }
      return {plugin_processes: kernels_info}
      // return engine.updateEngineStatus()
    },
    killPlugin(config){
      console.log('killing plugin', config, jserver._kernels)
      for(let k in jserver._kernels){
        const kernel = jserver._kernels[k]
        if(kernel.pluginId === config.id){
          jserver.killKernel(kernel)
        }
      }
    },
    async killPluginProcess(p) {
      // kernel.close()
      await jserver.killKernel(jserver._kernels[p.pid])
      // return engine.killPluginProcess(p)
    },
    heartbeat(){
      return true;
    },
    async startTerminal(){
      if(Object.keys(jserver.cached_servers).length <=0){
        api.alert('No jupyter engine is currently running.')
        return
      }
      //data-base-url="/user/oeway-imjoy-binder-image-8o8ztfkj/" data-ws-url="" data-ws-path="terminals/websocket/1"
      // ws_url = ws_url + base_url + ws_path;

      const buttons = []
      let i = 0
      for(let k in jserver.cached_servers){
        const {url, token} = jserver.cached_servers[k]
        // Connect to the notebook webserver.
        const serverSettings = ServerConnection.makeSettings({
          baseUrl: url,
          wsUrl: baseToWsUrl(url),
          token: token,
        })
        const ws_url = serverSettings.wsUrl + 'terminals/websocket/1'  //'wss://hub-binder.mybinder.ovh/user/oeway-imjoy-binder-image-8o8ztfkj/terminals/websocket/1'
        let name = new URL(url);
        name = name.pathname === '/' ? name.hostname: name.pathname ;
        buttons.push({
          label: name,
          event_id: k,
          ws_url: ws_url
        })
        i++;
      }
      const w = {
          name: "Terminal",
          type: "imjoy/terminal",
          config: {},
          w: 30,
          h: 15,
          standalone: false,
          data: {
            buttons: buttons
          }
      };
      const terminal_window = await api.createWindow(w);

      let terminal_started = false;
      
      const make_terminal = (ws_url) => {
      
        if(terminal_started){
          api.alert('Please open another terminal window if you want to switch server.')
          return
        }
       // clear the buttons;
       terminal_window.emit('show_buttons', [])
       terminal_started = true;
       var ws = new WebSocket(ws_url);
       // Terminal.applyAddon(fit);
       // var term = new Terminal();
       ws.onopen = async (event) => {
        
          terminal_window.emit('write', "Connected to terminal\r\n")
          const write = (data)=>{
            terminal_window.emit('write', data)
          }
          const disconnect = (data)=>{
            terminal_window.emit('write', "\r\nDisconnected!\r\n")
          }

          terminal_window.on('fit', (config)=>{
            // send the terminal size to the server.
            ws.send(JSON.stringify(["set_size", config["rows"], config["cols"],
                                        window.innerHeight, window.innerWidth]));
          
          })
          terminal_window.on('key', (key)=>{
            ws.send(JSON.stringify(['stdin', key]));
          });
          
          terminal_window.on("paste", data => {
            ws.send(JSON.stringify(['stdin', data]));
          })
        
          ws.onmessage = function(event) {
              var json_msg = JSON.parse(event.data);
              switch(json_msg[0]) {
                  case "stdout":
                      write(json_msg[1]);
                      break;
                  case "disconnect":
                      write("\r\n\r\n[CLOSED]\r\n");
                      break;
              }
          };
        };
      }
      if(buttons.length == 1){
        make_terminal(buttons[0].ws_url)
      }
      else{
        terminal_window.on('button_clicked', (event)=>{make_terminal(event.ws_url)})
      }
    },
    about(){
      api.alert('An ImJoy Engine for Jupyter Servers.')
    }
  })
  api.showMessage(`Plugin engine ${engine_config.name} connected.`)
}

function removeEngine(){

}

api.export({'setup': setup});