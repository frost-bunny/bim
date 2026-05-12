# BIM 数字孪生项目开发文档

本文档面向参与本项目的 3D/BIM 前端开发者，重点说明项目开发流程、技术栈、模型格式选型、核心加载链路、构件交互逻辑和常见问题排查。

## 1. 项目概览

本项目是一个基于 Web 的 BIM 数字孪生 Demo，使用 Vue 3 + TypeScript 构建界面，使用 CesiumJS 加载和渲染 3D Tiles 模型。当前主场景加载路径为：

```ts
const tilesetUrl = '/models/3d-tiles/tileset.json'
```

页面整体由三部分组成：

| 区域 | 作用 | 主要文件 |
| --- | --- | --- |
| 左侧构件树 | 按图层/材质分组展示模型构件，支持搜索、选择、隐藏 | `src/components/ModelTree.vue` |
| 中间三维视窗 | 初始化 Cesium Viewer，加载 3D Tiles，处理点击、悬浮、高亮、相机定位 | `src/components/TwinViewer.vue` |
| 右侧信息面板 | 展示当前选中构件信息和交互配置 | `src/App.vue` |

核心数据流是：

1. `App.vue` 调用 `loadTilesetGroups(tilesetUrl)`。
2. `src/utils/tiles.ts` 递归读取 `tileset.json` 中的瓦片内容。
3. 工具函数解析 `.b3dm`、`.cmpt`、`.glb` 中的 glTF / batch table / structural metadata。
4. 解析结果生成 `MaterialGroup[]`，供构件树和 Cesium 交互共用。
5. `TwinViewer.vue` 加载同一个 `tilesetUrl`，通过拾取到的 feature 属性或 content URL 回找构件 ID。

## 2. 开发环境与流程

### 2.1 基础要求

建议准备以下环境：

- Node.js：建议使用当前 LTS 版本。
- pnpm：项目已有 `pnpm-lock.yaml`，优先使用 pnpm，避免不同包管理器生成额外锁文件。
- 现代浏览器：建议 Chrome / Edge，便于查看 WebGL、网络请求和性能面板。
- 了解基础 WebGL / 3D 场景概念会很有帮助，尤其是相机、坐标系、包围盒、材质、mesh、primitive。

### 2.2 安装依赖

```bash
pnpm install
```

### 2.3 本地开发

```bash
pnpm run dev
```

`package.json` 中的开发命令是：

```json
"dev": "vite --host 0.0.0.0"
```

Vite 配置默认端口是 `5173`：

```ts
server: {
  port: 5173
}
```

浏览器访问：

```text
http://localhost:5173
```

### 2.4 构建检查

```bash
pnpm run build
```

该命令会先执行 `vue-tsc --noEmit` 做 TypeScript 类型检查，再执行 `vite build` 生成产物。只要改动涉及类型、Cesium API、组件 props、工具函数解析逻辑，都建议至少跑一次构建。

### 2.5 本地预览构建产物

```bash
pnpm run preview
```

## 3. 技术栈学习清单

| 技术 | 本项目用途 | 开发者需要重点了解 |
| --- | --- | --- |
| Vue 3 | 页面状态和组件组织 | Composition API、`ref`、`computed`、`watch`、组件 props/emits |
| TypeScript | 类型约束和模型数据结构 | interface、联合类型、DOM / Cesium 类型补充 |
| Vite | 开发服务和构建 | 静态资源路径、开发端口、构建输出 |
| CesiumJS | 3D Tiles 渲染、相机、拾取 | `Viewer`、`Cesium3DTileset`、`Cesium3DTileFeature`、`ScreenSpaceEventHandler` |
| 3D Tiles | 大体量 BIM 分块加载 | `tileset.json`、LOD、`b3dm`、`cmpt`、`glb` content |
| glTF / GLB | 具体三维模型承载格式 | nodes、meshes、materials、accessors、extensions |
| Three.js | 辅助 GLB mesh 拾取能力 | `GLTFLoader`、`Raycaster`、Object3D 层级 |
| three-mesh-bvh | 加速 mesh 射线拾取 | `computeBoundsTree`、`acceleratedRaycast` |

注意：当前主渲染链路使用 Cesium 加载 3D Tiles；`src/utils/gltf.ts` 和 `src/utils/meshPicker.ts` 更偏向 GLB 解析和辅助拾取能力，后续如果恢复单 GLB 模型模式或做格式转换预览，可以继续利用。

## 4. 目录结构说明

```text
bim/
├─ public/
│  └─ models/
│     ├─ 3d-tiles/           当前默认加载的 3D Tiles 数据
│     ├─ 3d-tiles.copy/      另一套 GLB content 的 3D Tiles 数据
│     ├─ bridge.glb          独立 GLB 模型资产
│     └─ t.glb               独立 GLB 模型资产
├─ scripts/
│  └─ uniquify-glb-nodes.mjs 给 GLB node 名称追加唯一后缀的辅助脚本
├─ src/
│  ├─ components/
│  │  ├─ ModelTree.vue       构件树
│  │  └─ TwinViewer.vue      Cesium 三维视窗
│  ├─ types/
│  │  └─ model.ts            构件与分组数据类型
│  ├─ utils/
│  │  ├─ tiles.ts            3D Tiles / B3DM / CMPT / GLB 元数据解析
│  │  ├─ gltf.ts             独立 GLB 元数据解析
│  │  └─ meshPicker.ts       Three.js 辅助射线拾取
│  ├─ App.vue                页面状态聚合和布局
│  ├─ main.ts                应用入口
│  └─ styles.css             全局样式
├─ vite.config.ts            Vite + Vue + Cesium 插件配置
└─ package.json              脚本和依赖
```

## 5. 模型格式基础与前端选型对比

BIM/数字孪生前端开发最容易踩坑的地方之一，就是把“工程软件原始格式”和“浏览器运行态格式”混在一起。前端最终需要的是能被浏览器高效下载、解析、渲染、拾取和分层加载的格式。

### 5.1 常见格式说明

| 格式 | 基础说明 | 适合场景 | 前端直接使用建议 |
| --- | --- | --- | --- |
| glTF / GLB | glTF 是面向实时渲染的开放三维格式，GLB 是二进制打包形式，通常包含 JSON、几何、材质、贴图 | 单体模型展示、轻量 BIM 预览、构件级拆分后的模型、产品模型 | 推荐。小到中等模型优先使用 GLB，加载简单，生态成熟 |
| 3D Tiles | 面向海量三维空间数据的分块、分层级加载规范，入口通常是 `tileset.json` | 大体量 BIM、园区、桥梁、城市级数字孪生、需要 LOD 和流式加载的场景 | 强烈推荐用于大模型。本项目当前主格式 |
| B3DM | Batched 3D Model，是 3D Tiles 1.0 常见瓦片内容格式，内部通常封装 glTF/GLB 和 batch table | 一块瓦片里承载多个批量构件或模型批次 | 前端通常只消费，不手写，由转换工具生成 |
| CMPT | Composite Tile，可组合多个 3D Tiles 子内容，例如多个 b3dm | 复杂瓦片组合、转换工具输出的组合瓦片 | 前端通常只消费，不手写 |
| IFC | BIM 领域常见开放交换格式，保存构件、属性、关系、空间结构等工程语义 | 设计协同、工程数据交换、服务端解析、BIM 原始数据归档 | 不建议作为大型前端运行态主格式，通常转换为 GLB 或 3D Tiles |
| OBJ | 老牌通用网格格式，结构简单，常配合 MTL 材质文件 | 简单几何、美术模型、临时查看 | 不适合作为 BIM 主格式，属性和层级能力弱 |
| FBX | Autodesk 生态常见格式，支持动画、骨骼、材质等 | 美术资产、动画模型、中间交换 | 浏览器可加载但体积和兼容性不稳定，建议转换为 GLB |
| STL | 主要描述三角面片，制造/打印领域常见 | 3D 打印、制造件预览 | 只适合几何预览，不适合 BIM 属性场景 |
| RVT | Revit 原生工程文件 | BIM 建模源文件、设计交付 | 前端不直接消费，需要转换 |
| DGN | Bentley 生态工程设计格式 | 基建、道路、桥梁、工程设计 | 前端不直接消费，需要转换 |
| DWG / DXF | CAD 图纸格式 | 二维/三维 CAD 图纸交换 | 前端通常通过 CAD 解析服务或转换结果展示 |

### 5.2 前端开发选型建议

| 需求 | 推荐格式 | 原因 |
| --- | --- | --- |
| 单个模型预览，体积不大 | GLB | 浏览器生态成熟，加载简单，和 Three.js / Babylon.js / Cesium 都容易集成 |
| 大型 BIM 模型，需要边看边加载 | 3D Tiles | 支持分块、LOD、视锥裁剪和缓存控制 |
| 城市、园区、桥梁、隧道、道路等空间场景 | 3D Tiles | Cesium 对地理空间、相机和大场景支持更好 |
| 需要和地图坐标结合 | 3D Tiles | `tileset.json` 可包含 transform / boundingVolume，更适合空间定位 |
| 需要保留设计源数据 | IFC / RVT / DGN / DWG 作为源文件 | 原始格式适合归档和二次转换，不适合直接作为前端运行态 |
| 需要浏览器内做高性能构件拾取 | GLB 或带 metadata 的 3D Tiles | 前提是转换时保留构件 ID、名称、图层等元数据 |
| 只展示简单静态几何 | GLB | OBJ/STL 可用但不推荐作为长期格式 |

简化结论：

- 小模型、单模型、产品级预览：优先 GLB。
- 大模型、BIM、城市级/园区级数字孪生：优先 3D Tiles。
- 工程软件原始交付物：保留为源文件，前端运行态转换为 GLB 或 3D Tiles。
- 如果要做构件级点击、隐藏、高亮、属性面板，转换流程必须保留稳定的构件标识。

### 5.3 本项目为什么使用 3D Tiles

当前项目默认加载 `public/models/3d-tiles/tileset.json`，适合本项目的原因是：

1. 模型由大量瓦片组成，浏览器无需一次性加载完整模型。
2. Cesium 可以根据相机距离和视角自动选择需要加载的瓦片。
3. `TwinViewer.vue` 可以通过 `tileVisible` / `tileUnload` 维护当前可见瓦片中的 feature 和 content。
4. `utils/tiles.ts` 可以从 `.b3dm`、`.cmpt`、`.glb` 中解析构件目录，前端能建立左侧树和三维对象之间的映射。

## 6. 核心模型加载与解析链路

### 6.1 构件树数据解析

入口在 `src/App.vue`：

```ts
materialGroups.value = await loadTilesetGroups(tilesetUrl)
```

`loadTilesetGroups` 位于 `src/utils/tiles.ts`，主要步骤：

1. 请求 `tileset.json`。
2. 递归收集每个 tile 的 `content.uri` 或 `content.url`。
3. 根据内容 magic 识别格式：
   - `glTF`：按 GLB 解析。
   - `b3dm`：解析 header、feature table、batch table，再解析内部 GLB。
   - `cmpt`：逐个拆出子 tile，再递归解析。
4. 优先读取 `EXT_structural_metadata`。
5. 如果没有 structural metadata，则尝试读取 batch table。
6. 如果仍然没有属性，则从 glTF nodes / meshes / materials 生成 fallback 记录。
7. 输出 `MaterialGroup[]`。

项目内部构件类型定义在 `src/types/model.ts`：

```ts
export interface ModelNodeItem {
  id: string
  name: string
  runtimeName: string
  nodeIndex: number
  meshIndex: number
  materialIndex: number
  materialName: string
  groupId: string
  primitiveCount: number
  center: [number, number, number]
  boundsMin: [number, number, number]
  boundsMax: [number, number, number]
}
```

### 6.2 Cesium 场景加载

`src/components/TwinViewer.vue` 初始化 `Viewer` 时关闭了大部分默认 UI：

- `animation: false`
- `timeline: false`
- `baseLayerPicker: false`
- `geocoder: false`
- `sceneModePicker: false`
- `infoBox: false`

当前场景也关闭了地球和天空效果，让 BIM 模型更像独立数字孪生场景：

```ts
viewer.scene.globe.show = false
viewer.scene.backgroundColor = Color.fromCssColorString('#07111f')
```

Tileset 加载使用：

```ts
const tileset = await Cesium3DTileset.fromUrl(props.tilesetUrl, {
  maximumScreenSpaceError: 12,
  dynamicScreenSpaceError: true,
  skipLevelOfDetail: true,
  cacheBytes: 512 * 1024 * 1024,
  maximumCacheOverflowBytes: 256 * 1024 * 1024,
  featureIdLabel: 'featureId_0'
})
```

这些参数会影响模型清晰度、加载速度、内存占用和交互体验。大模型开发时不要只看“能不能显示”，还要关注网络请求数量、显存占用、相机移动时的卡顿和瓦片卸载行为。

### 6.3 构件拾取与映射

Cesium 点击和悬浮通过 `ScreenSpaceEventHandler` 绑定：

- `LEFT_CLICK`：选择构件。
- `MOUSE_MOVE`：悬浮拾取构件。
- `mouseleave`：清空悬浮状态。

拾取逻辑优先识别 `Cesium3DTileFeature`：

```ts
const picked = viewer.scene.pick(position, 5, 5)
```

项目会从 feature 上读取这些属性尝试匹配构件：

- `propertiesID`
- `meshName`
- `name`

如果不是 feature，则继续根据 tile content URL 匹配 `runtimeName` 中注册过的内容 key。

这意味着：如果转换模型时没有保留稳定的 `propertiesID`、`meshName`、`name` 或可追溯的 content 文件名，前端构件树和三维模型就很难准确联动。

### 6.4 高亮、隐藏与聚焦

构件样式同步集中在 `syncFeatureStyles()`：

- `featureByNodeId`：保存已加载瓦片中的 `Cesium3DTileFeature`。
- `contentByNodeId`：保存没有 feature 粒度时可直接控制的 tile content model。
- `hiddenNodeIds`：记录被隐藏的构件 ID。
- `selectedNodeId`：当前选中构件。
- `hoveredNodeId`：当前悬浮构件。

当前隐藏逻辑不是完全 `show = false`，而是使用低透明颜色：

```ts
const hiddenFeatureColor = Color.fromCssColorString('#808895').withAlpha(0.12)
```

这样做的好处是用户仍能看到模型整体轮廓；如果业务要求真正隐藏，可在 `applyFeatureStyle` / `applyContentStyle` 中恢复 `show = false`，但要测试拾取和相机定位是否仍符合预期。

## 7. 常见开发任务

### 7.1 替换默认模型

1. 将新的 3D Tiles 数据放到 `public/models/` 下，例如：

```text
public/models/my-tiles/tileset.json
```

2. 修改 `src/App.vue`：

```ts
const tilesetUrl = '/models/my-tiles/tileset.json'
```

3. 确认浏览器 Network 面板中 `tileset.json` 和所有瓦片文件都能正常返回。
4. 如果模型能显示但无法选择构件，检查转换后的 metadata 是否包含可匹配字段。

### 7.2 增加右侧构件属性

当前右侧信息来自 `selectedInfo`，它的基础字段来自 `ModelNodeItem`。如果需要展示更多属性，建议：

1. 先确认源模型 metadata 中是否有该属性。
2. 在 `src/utils/tiles.ts` 中解析该属性。
3. 扩展 `src/types/model.ts` 的 `ModelNodeItem`。
4. 在 `src/App.vue` 的右侧面板展示。

不要只在 UI 写死字段名，否则换模型后很容易出现空值或无法追踪来源。

### 7.3 调整拾取字段

如果转换工具输出的字段不是 `propertiesID`、`meshName`、`name`，需要修改 `TwinViewer.vue` 的 `resolveFeatureNodeId`：

```ts
const candidates = [
  getFeatureStringProperty(feature, 'propertiesID'),
  getFeatureStringProperty(feature, 'meshName'),
  getFeatureStringProperty(feature, 'name')
].filter(Boolean)
```

建议优先让转换流程输出统一字段，而不是每接入一套模型就在前端堆很多兼容分支。

### 7.4 调整模型地理位置或姿态

当前 `TwinViewer.vue` 使用固定经纬度生成模型矩阵：

```ts
const tilesetModelMatrix = Transforms.eastNorthUpToFixedFrame(
  Cartesian3.fromDegrees(116.3913, 39.9075, 30)
)
```

如果模型自身 `tileset.json` 已经包含准确的地理 transform，或者后续要支持多模型定位，应重新评估这里是否需要覆盖 `modelMatrix`。模型位置不对、角度不对、上下颠倒，通常都和 transform、坐标轴或转换流程有关。

### 7.5 给 GLB node 名称补唯一后缀

`scripts/uniquify-glb-nodes.mjs` 用于给 GLB 中的 node 名称追加 `__node_索引`，适合处理 node 名称重复导致无法稳定映射的问题。

用法：

```bash
node scripts/uniquify-glb-nodes.mjs input.glb output.glb
```

如果省略 `output.glb`，脚本会覆盖输入文件。覆盖前务必保留原始模型备份。

## 8. 常见问题与排查

### 8.1 页面空白或 Cesium 报资源错误

排查顺序：

1. 确认 `vite-plugin-cesium` 已在 `vite.config.ts` 中启用。
2. 确认 `main.ts` 引入了 Cesium widgets 样式：

```ts
import 'cesium/Build/Cesium/Widgets/widgets.css'
```

3. 查看浏览器 Console 是否有 WebGL、静态资源路径或 worker 加载错误。

### 8.2 模型不显示

重点检查：

- `tilesetUrl` 是否正确。
- `public/models/.../tileset.json` 是否能直接在浏览器访问。
- `tileset.json` 中的 `content.uri` 相对路径是否真实存在。
- `TwinViewer.vue` 中的 `modelMatrix` 是否把模型移动到了当前视角之外。
- 瓦片是否过大导致加载很慢，可看 Network 和 Performance。

### 8.3 构件树有数据，但点击模型无法联动

可能原因：

- 三维拾取到的 feature 没有 `propertiesID` / `meshName` / `name`。
- `utils/tiles.ts` 解析出的 `id` 与 Cesium feature 属性不一致。
- 3D Tiles content 是整个模型粒度，缺少 feature 粒度。
- 转换工具丢失了 BIM 构件 ID 或图层属性。

建议先在 `resolveFeatureNodeId` 附近临时打印 feature 属性，确认 Cesium 实际能读到什么字段，再决定是修前端映射，还是修模型转换流程。

### 8.4 隐藏构件后仍能看到淡淡轮廓

这是当前设计。项目为了保留空间上下文，对隐藏构件使用了低透明颜色，而不是完全 `show = false`。如果业务要求完全隐藏，需要修改 `applyFeatureStyle` 和 `applyContentStyle`，并测试选中、悬浮和相机聚焦。

### 8.5 选中后没有自动定位

自动定位需要同时满足：

- 右侧开启“选中聚焦”。
- 开启“自动定位”。
- 当前构件已经被 Cesium 加载并缓存到 `featureByNodeId` 或 `contentByNodeId`。
- 能从 feature/content 中取到 bounding sphere。

如果目标构件所在瓦片还没加载，可能无法立刻定位。

### 8.6 中文显示乱码

当前 `README.md` 中存在中文乱码迹象，通常是文件编码或历史写入方式不一致导致。新增文档应统一使用 UTF-8。后续如果要修复 README，建议单独做一次编码清理，避免和业务改动混在一起。

### 8.7 大模型卡顿或内存高

优先检查：

- `maximumScreenSpaceError` 是否过低。越低越清晰，但加载压力更大。
- `cacheBytes` 和 `maximumCacheOverflowBytes` 是否过大。
- 是否开启了过多高亮/透明样式，透明渲染通常更费。
- 模型转换时是否生成了过多小瓦片，导致请求数量过多。
- 浏览器是否开启硬件加速。

## 9. 开发建议

1. 模型问题先看 Network，再看 Console，最后看代码。很多问题本质是路径、格式或转换输出不符合预期。
2. 前端不要依赖不稳定的 mesh 名称做长期业务 ID。优先使用转换流程保留下来的唯一构件 ID。
3. 3D Tiles 的 `tileset.json`、瓦片文件、metadata 字段是一组契约，换模型时要一起验证。
4. 新增构件属性时，先定义数据来源，再扩展类型和 UI。
5. 修改 Cesium 性能参数时，需要同时观察清晰度、加载速度、相机移动体验和内存占用。
6. 原始 BIM 文件适合归档和转换，前端运行态应使用 GLB 或 3D Tiles。
