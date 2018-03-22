export default function (Vue) {
  // 鉴别Vue的版本
  const version = Number(Vue.version.split('.')[0])

  if (version >= 2) {
    // 通过mixin将vuexInit混淆到Vue实例的beforeCreate钩子中
    Vue.mixin({ beforeCreate: vuexInit })
  } else {
    // override init and inject vuex init procedure
    // for 1.x backwards compatibility.
    const _init = Vue.prototype._init
    Vue.prototype._init = function (options = {}) {
      options.init = options.init
        ? [vuexInit].concat(options.init)
        : vuexInit
      _init.call(this, options)
    }
  }

  /**
   * Vuex init hook, injected into each instances init hooks list.
   */
  // vuexInit钩子，会存入每一个Vue实例等钩子列表
  function vuexInit () {
    const options = this.$options
    // store injection
    // 注入一个store 到Vue 的实例上面，存在store 表示是root节点
    if (options.store) {
      this.$store = typeof options.store === 'function'
        ? options.store()
        : options.store
    } else if (options.parent && options.parent.$store) {
      // 子组件直接从父组件获取$store,这样保证所有组件都公用了一份store
      this.$store = options.parent.$store
    }
  }
}
