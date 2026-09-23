# PDF 绘图与 Excalidraw 可行性验证（2026-09-23）

## 结论

**建议分阶段集成官方 `@excalidraw/excalidraw`，作为 PDF 的“扩展绘图”模式；不要整体替换现有阅读/手写批注层。** 官方包能立即提供线条、椭圆、箭头、矩形、文字、选择/移动、撤销/重做和快捷键。它的橡皮擦按整个元素删除，不能直接满足当前用户指定的圆形局部擦除、命中笔画降低 70% 不透明度、圆润且与速度相关的渐隐尾迹，也不能保证笔尾硬件橡皮在各设备上连续工作。这些交互应继续由本项目的 Pointer Events 绘图层处理与验收。

Obsidian Excalidraw 插件是针对 Obsidian API、Vault 和 Electron 的集成，不是可直接嵌入此 Next.js 网站的独立 React 组件。它的源码采用 AGPL-3.0；本方案只引用 MIT 的 Excalidraw 官方 npm 包，不复制 Obsidian 插件实现。

## 已做的独立原型

- 未链接实验页：`/experimental/pdf-excalidraw`，源码在 `app/experimental/pdf-excalidraw/page.tsx`、`components/excalidraw-pdf-prototype*.tsx`。
- 本地选择 PDF 或点击“加载测试 PDF”；用 `react-pdf` 读取原页，阅读模式保留文字层。将页图像临时转换为 Excalidraw 的锁定背景元素，在独立绘图模式添加形状或自由书写。
- 按文件名、大小、修改时间、页码将绘图元素写入当前浏览器 `localStorage`。变更后延迟 900 ms 合并写；退出编辑、换页和换文件立即刷新待写内容。PDF 背景图像不写入本地存储。
- **浏览器实测**：合成的一页 PDF 在阅读模式可以选择并复制文字；进入编辑后背景图像对齐，绘制一条自由笔画，退出再进入后笔画仍显示。`npx tsc --noEmit` 和 `npm run build` 均通过，Next 16.3.4 构建中实验页成功生成。
- 限制：这是研究原型，不接生产资料库 API、不跨浏览器同步、不处理冲突、不保证本地存储容量；编辑模式看到的是 PDF 页图像，不能选择其中的 PDF 文字。Chrome 扩展自动化不允许上传本地文件，故浏览器验收使用页内生成的测试 PDF，手工上传流程未自动验证。

## 体积与性能

2026-09-23 读取 npm `@excalidraw/excalidraw@0.18.1` 包：tarball 31,234,066 B（含开发构建），解包后生产目录 17,692,835 B，其中字体 13,107,068 B、JS 2,792,312 B、语言包 1,648,766 B、CSS 144,689 B。它有额外运行依赖，这些数字不能视为页面最终下载量。Next 的客户端动态组件仅在打开实验页加载；仍需用生产网络面板测实际资源、移动端内存和大页耗时。官方默认可能从 CDN 下载字体，正式接入应自托管字体以免学习资料页面向第三方发出资源请求。

## 与当前批注数据并存

当前 `library_annotations` 每页存 `strokes_json`、`revision`，轨迹坐标为归一化的 `[0,1]`，上限为 1,000 笔、30,000 点、512 KiB；当前客户端有单页撤销栈、浏览器草稿、900 ms 延迟上传、409 冲突提示。不能将 Excalidraw 场景 JSON 直接写入 `strokes_json`：其中有线、椭圆、文本、图层、图片引用和不同坐标系，现有校验会拒绝，也无法无损回写原始笔画。

正式接入建议新增按 `owner_id/document_id/page` 定位的 `scene_json` + `revision`，保留现有 `strokes_json` 和接口。旧笔迹在阅读模式原样显示；扩展绘图模式可将旧笔迹叠加到 PDF 背景供参照，后续如需在扩展模式编辑旧笔迹，单独做一次性转换并逐笔核对宽度、旋转、缩放和撤销。Excalidraw 以固定 PDF 原页尺寸为场景坐标；页面缩放只改变显示比例。编辑状态持久化时只存非背景元素与需要的图片资产引用，绝不重复保存 PDF 页 base64。保存仍采用本地草稿 + 900 ms 合并 + 最大等待时间 + 修订号冲突处理；`onChange` 也可能因画布状态变动触发，应比较元素版本，避免无意义写入。

## 功能取舍

| 用户诉求 | 官方包能否直接提供 | 建议位置 |
| --- | --- | --- |
| 线条、箭头、矩形、椭圆、文字、元素选择与变形 | 是 | 扩展绘图模式；验收 PDF 页对齐 |
| 常用快捷键与撤销/重做 | 是，需处理与阅读器焦点的冲突 | 扩展绘图模式；阅读模式维持自己的快捷键 |
| 真正直尺与圆规（尺寸、角度、固定半径、吸附） | 线/椭圆只是基础，不等于完整实体工具 | 二期自定义控制器；需求要细化 |
| 连续局部圆形擦除、70% 命中淡化、速度相关平滑尾迹 | 否；官方原生按整元素删除 | 现有 PDF 指针/SVG 层自主实现 |
| 数位笔尾部 eraser | 非可靠内置；Obsidian 使用额外脚本支持，设备映射需实测 | Pointer Events，检测 `button=5`/`buttons & 32` 并保持到 pointerup |
| PDF 文字选择 | Excalidraw 中的 PDF 背景是图片 | 原阅读模式；切换模式而非覆盖文字层 |

## 建议实施与验收

1. 先把当前阅读模式的圆形擦除、尾迹和数位笔交互做稳；做设备矩阵（鼠标、触控、Surface/Wacom 等实际可用设备）。
2. 增加可选“扩展绘图”模式与逐页场景表/API，第一版只允许基础矢量工具，不允许图片/外链/嵌入物；自托管字体，动态加载编辑器。
3. 让两种批注在阅读模式共同呈现，保持老笔迹原样可继续编辑。扩展模式保存跨刷新/跨设备验证；两窗口 revision 冲突、断网恢复、移动端触控、缩放/旋转后坐标、500 页文档按需加载都应通过。
4. 后续再做直尺/圆规精确交互及旧笔迹转换，不能只因为有 line/ellipse 就宣布完成。

预估：最小可上线的“扩展绘图”模式、双格式保存与验收约 3–5 个工作日；直尺/圆规精确工具及高质量旧笔迹转换另需约 2–4 个工作日；硬件笔尾与尾迹需真实设备验收，时间取决于设备覆盖。

## 官方资料

- Excalidraw [MIT 许可](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)、[React 包安装/字体部署](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation)、[嵌入与 API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props)。
- [Obsidian Excalidraw 插件 AGPL-3.0 许可](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/LICENSE)及[硬件橡皮脚本说明](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/README.md)。
- 上游仍开放的[局部擦除请求](https://github.com/excalidraw/excalidraw/issues/4904)和[整笔擦除行为报告](https://github.com/excalidraw/excalidraw/issues/10332)；[插件数位笔需求汇总](https://github.com/zsviczian/obsidian-excalidraw-plugin/issues/2773)。
