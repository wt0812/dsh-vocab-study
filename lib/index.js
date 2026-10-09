// dsh-vocab-study — Host 侧入口（由 tools/build-plugin.py 生成）
//
// 这个插件是纯客户端 UI 插件：数据只存在用户浏览器里，不上报、不联网。
// Host 侧刻意什么都不做 —— 没有 Host 逻辑可写，也不该凭空造一个服务出来。
// 保留这个入口是因为 package.json 需要一个可解析的主入口；它被加载后
// 不做任何事，这是有意为之。

export function apply() {}

export const name = 'dsh-vocab-study';
