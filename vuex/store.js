import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert } from './util'

let Vue // bind on install

// store构造函数
export class Store {
  constructor (options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    /*
     * 浏览器环境下，如果插件还没有安装并且有Vue，则会自动安装
     */
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    if (process.env.NODE_ENV !== 'production') {
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`)
      assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
      assert(this instanceof Store, `Store must be called with the new operator.`)
    }

    const {
      plugins = [],       // 应用的插件，这些插件直接接收store 作为唯一参数，可以监听mutation 或提交mutation
      strict = false      // 是否开启严格模式，开启后在任何mutation 处理函数以外修改 Vuex state 都会抛出错误
    } = options

    // state表示rootState
    let {
      state = {}
    } = options
    if (typeof state === 'function') {
      state = state() || {}
    }

    // store internal state
    this._committing = false                        // 标志一个提交状态，作用是保证对Vuex中state修改只能在mutation 的回调函数，而不能在外部随意修改
    this._actions = Object.create(null)             // 存储用户定义的所有actions
    this._actionSubscribers = []                    // 存储用户定义的所有actionSubscribers
    this._mutations = Object.create(null)           // 存储用户定义的所有mutations
    this._wrappedGetters = Object.create(null)      // 存储用户定义的所有getters
    this._modules = new ModuleCollection(options)   // module收集器
    this._modulesNamespaceMap = Object.create(null) // 根据命名空间存放module
    this._subscribers = []                          // 存储订阅subscriber
    this._watcherVM = new Vue()                     // Vue对象实例，主要利用Vue实例方法$watch 来实现观测变化

    // bind commit and dispatch to self
    // 将dispatch 和 commit 绑定到Store 实例上面
    const store = this
    const { dispatch, commit } = this
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    // 挂载strict到this上，表示是否开启严格模式，开发环境建议开启，生产环境建议关闭(会有性能开销)
    this.strict = strict

    // init root module.
    // this also recursively registers all sub-modules
    // and collects all module getters inside this._wrappedGetters
    // 初始化根模块，同时也递归注册来所有子模块
    // 并且收集所有module的getters丢到this._wrappedGetters中，
    installModule(this, state, [], this._modules.root)

    // initialize the store vm, which is responsible for the reactivity
    // (also registers _wrappedGetters as computed properties)
    // 重设store vm，新建vue对象，利用其内部的响应式实现state和computed
    resetStoreVM(this, state)

    // apply plugins
    // 应用plugins
    plugins.forEach(plugin => plugin(this))

    // devtools插件
    if (Vue.config.devtools) {
      devtoolPlugin(this)
    }
  }

  // 获取state
  get state () {
    return this._vm._data.$$state
  }

  // 不允许设置state
  set state (v) {
    if (process.env.NODE_ENV !== 'production') {
      assert(false, `Use store.replaceState() to explicit replace store state.`)
    }
  }

  // 调用mutation 的commit 方法，接收三个参数，分别表示mutation的类型，payload参数承载，options配置
  commit (_type, _payload, _options) {
    // check object-style commit
    // 参数校验
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    // 取出type 对应的mutation方法
    const entry = this._mutations[type]
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }
    // 执行mutation中所有方法
    this._withCommit(() => {
      entry.forEach(function commitIterator (handler) {
        handler(payload)
      })
    })
    this._subscribers.forEach(sub => sub(mutation, this.state))

    if (
      process.env.NODE_ENV !== 'production' &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  // 调用action 的dispatch方法，接收两个参数，分别表示action 的类型，payload参数承载
  dispatch (_type, _payload) {
    // check object-style dispatch
    // 参数校验
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = { type, payload }
    // 取出type 对应的action方法
    const entry = this._actions[type]
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    this._actionSubscribers.forEach(sub => sub(action, this.state))

    // 对action 的对象数组长度做判断，大于1则包装成一个Promise，只有一个则直接返回(wrappedActionHandler(payload, cb))
    return entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)
  }

  // 订阅监听mutation
  subscribe (fn) {
    return genericSubscribe(fn, this._subscribers)
  }

  // 订阅监听action
  subscribeAction (fn) {
    return genericSubscribe(fn, this._actionSubscribers)
  }

  // 响应式的检测一个getter的返回值，当值改变时调用回调
  watch (getter, cb, options) {
    if (process.env.NODE_ENV !== 'production') {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  // 重置state
  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  // 注册一个动态模块，当业务进行异步加载的时候，可以通过该接口动态注册module
  registerModule (path, rawModule, options = {}) {
    // 把字符串转为数组
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }

    // 注册
    this._modules.register(path, rawModule)
    // 初始化module
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
    // 通过vm重设store，新建Vue对象，使用Vue内部的响应式实现注册state以及computed
    resetStoreVM(this, this.state)
  }

  // 取消注册一个动态module
  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (process.env.NODE_ENV !== 'production') {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    // 注销
    this._modules.unregister(path)
    this._withCommit(() => {
      // 获取父级state
      const parentState = getNestedState(this.state, path.slice(0, -1))
      // 从父级中删除
      Vue.delete(parentState, path[path.length - 1])
    })
    // 充值store
    resetStore(this)
  }

  // 热更新
  hotUpdate (newOptions) {
    // 更新module
    this._modules.update(newOptions)
    // 重置store
    resetStore(this, true)
  }

  // 修改state，进行包装，保证在同步修改state 的过程中this._committing 始终为true
  // 观察state 变化的时候，如果this._committing 不为true，就说明修改状态有问题
  _withCommit (fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

// 接收两个参数，分别表示回调函数和subs类型，返回一个监听函数
function genericSubscribe (fn, subs) {
  if (subs.indexOf(fn) < 0) {
    subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

// 重置store，重新初始化module
function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

// 通过vm重设store，新建Vue对象使用Vue内部的响应式实现注册state以及computed
function resetStoreVM (store, state, hot) {
  // 存放之前的vm对象
  const oldVm = store._vm

  // bind store public getters
  store.getters = {}
  const wrappedGetters = store._wrappedGetters
  const computed = {}

  // 通过Object.defineProperty 为每一个getter 设置get方法，
  // 也就是我们在组件中调用`this.$store.getters.xxxgetters`这个方法的时候，会访问`store._vm['getters']`
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
    computed[key] = () => fn(store)
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  const silent = Vue.config.silent
  // 将silent设置为true是为了取消这个_vm的所有日志和警告
  Vue.config.silent = true
  // new 了一个Vue 对象，运用Vue 内部的响应式原理注册state和computed
  store._vm = new Vue({
    data: {
      $$state: state
    },
    computed
  })
  Vue.config.silent = silent

  // enable strict mode for new vm
  // 使用严格模式，保证修改store只能通过mutation
  if (store.strict) {
    enableStrictMode(store)
  }

  if (oldVm) {
    // 接触旧vm的state引用，以及销毁旧的Vue对象
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    Vue.nextTick(() => oldVm.$destroy())
  }
}

// 注册module，传入五个参数，表示Store 实例，根state，当前嵌套路径模块的路径数组，当前安装的模块，是否热更新
function installModule (store, rootState, path, module, hot) {
  const isRoot = !path.length                               // 通过path的长度判断是否为根module
  const namespace = store._modules.getNamespace(path)       // 通过路径获取module的命名空间

  // register in namespace map
  // 如果namespace在_modulesNamespaceMap中注册
  if (module.namespaced) {
    store._modulesNamespaceMap[namespace] = module
  }

  // set state，热更新模式下不做以下操作
  if (!isRoot && !hot) {
    // 获取父级的state
    const parentState = getNestedState(rootState, path.slice(0, -1))
    // 获取module名称
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      // 将子module设为响应式
      Vue.set(parentState, moduleName, module.state)
    })
  }

  const local = module.context = makeLocalContext(store, namespace, path)

  // 遍历注册mutation
  module.forEachMutation((mutation, key) => {
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  // 遍历注册action
  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  // 遍历注册getter
  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  // 遍历安装子module
  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''

  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (process.env.NODE_ENV !== 'production' && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

function makeLocalGetters (store, namespace) {
  const gettersProxy = {}

  const splitPos = namespace.length
  Object.keys(store.getters).forEach(type => {
    // skip if the target getter is not match this namespace
    if (type.slice(0, splitPos) !== namespace) return

    // extract local getter type
    const localType = type.slice(splitPos)

    // Add a port to the getters proxy.
    // Define as getter property because
    // we do not want to evaluate the getters in this time.
    Object.defineProperty(gettersProxy, localType, {
      get: () => store.getters[type],
      enumerable: true
    })
  })

  return gettersProxy
}

// 注册mutation，接收四个参数，分别为当前Store实例，mutation key，mutation执行的回调函数，当前模块路径
function registerMutation (store, type, handler, local) {
  // 拿到对应的mutation 数组对象
  const entry = store._mutations[type] || (store._mutations[type] = [])
  // push mutation的一个包装函数到这个数组中
  entry.push(function wrappedMutationHandler (payload) {
    handler.call(store, local.state, payload)
  })
}

// 注册action
function registerAction (store, type, handler, local) {
  // 取出type对应的action
  const entry = store._actions[type] || (store._actions[type] = [])
  entry.push(function wrappedActionHandler (payload, cb) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload, cb)
    // 判断res是否是Promise，不是的话转为Promise
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      // 存在devtool的时候，触发vuex:error 给devtool
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

// 注册getter
function registerGetter (store, type, rawGetter, local) {
  // 不存在则直接返回
  if (store._wrappedGetters[type]) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  // 放到函数中包装getter
  store._wrappedGetters[type] = function wrappedGetter (store) {
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

// 开启严格模式
function enableStrictMode (store) {
  // 检测`this._data.$$state`的变化，看看state的变化是否是通过执行mutation的函数改变的
  // 如果是外部函数改变的，那么`store._commintting`为false，这样就会抛出一个错误
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (process.env.NODE_ENV !== 'production') {
      assert(store._committing, `Do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

// 根据path查找state上嵌套的state，传入 rootState 和 path，计算出当前模块的父模块的 state
// 由于模块的path 是根据模块的名称concat 连接的，所以path 的最后一个元素就是当前模块的模块名
function getNestedState (state, path) {
  return path.length
    ? path.reduce((state, key) => state[key], state)
    : state
}

function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (process.env.NODE_ENV !== 'production') {
    assert(typeof type === 'string', `Expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}

// 暴露给外部的插件install方法,供Vue.use调用安装插件
export function install (_Vue) {
  // 避免重复安装(Vue.use内部也会检测一次是否重复安装同一个插件)
  if (Vue && _Vue === Vue) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  // 保存Vue，同时用于检测是否重复安装
  Vue = _Vue
  // 将vuexInit minxin进Vue.beforeCreate，或1.x将_init挂载到prototype上
  applyMixin(Vue)
}
