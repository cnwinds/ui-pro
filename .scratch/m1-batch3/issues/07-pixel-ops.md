# 07 像素能力

Status: ready-for-agent

先读 `../spec.md`，其中的共享接口、并行规则对本工单同样适用。

## 归属

只改这些文件：

- `packages/perception/src/pixel/**`（`types.ts` 不改）
- `packages/perception/src/models/**`：`catalog.ts` 的数据可以按核实结果更正（例如模型的实际输入尺寸），改了在 Comments 里说明
- `packages/perception/test/pixel/**`、`packages/perception/test/models/**`（新建）

`packages/perception/src` 下已有的文件（`ink.ts`、`image.ts`、`opencv.ts` 等）可以导入使用，但不要修改：第二波的工单 05 会改它们。需要它们有变化时写进 Comments。

## 背景

方案 §6.5 的表（抠取、补全、文字剥离、提升分辨率四行）；§6.6 全节：本地与云端的分工、八条约束、外发档位；§6.7 先粗后精。`docs/adr/0003-image-models-dashscope-and-onnx.md`。模型目录 `packages/perception/src/models/catalog.ts`。

`PixelOps` 是给资产构建（工单 06）用的纯像素能力：输入输出都是内存里的图，不知道项目、界面规格和决定。锁定、外发记录、预算的存储由构建通过 `PixelContext` 传进来，本工单只负责在正确的时机调用它们。

每一步都按“由简到难”自动选方法：能用解析方法就不用模型，能用本地模型就不用云端。`quality: 'draft'` 时绝不调用云端。

## 要做的事

### 1. 本地模型：`createModelStore`

- 缓存目录：默认 Windows 上 `%LOCALAPPDATA%\ui-pro\models`，其他系统 `~/.cache/ui-pro/models`；环境变量 `UI_PRO_MODEL_DIR` 可以覆盖（测试用）。
- `path(name)`：文件已在且校验过就直接返回；否则下载。
  - 下载地址依次尝试：环境变量 `HF_ENDPOINT`、`MODEL_ENDPOINTS`，URL 为 `<endpoint>/<repo>/resolve/main/<path>`。
  - 边下边写 `<文件>.part`；通过 `onProgress` 报告进度，每 10% 或每 2 秒一次，用中文。
  - 下完校验大小和 sha256，通过后原子改名。
  - 都失败时报 `E_MODEL_UNAVAILABLE`，提示设置 `HF_ENDPOINT`，或手动下载后放进缓存目录。
- 校验一次 200 MB 的文件要时间：校验结果记在旁边的小文件里（大小、修改时间、哈希），没变就不重算。
- 两个进程同时下载同一个模型不能互相破坏（各用唯一的 `.part` 名，原子改名）。
- ONNX 会话每个进程每个模型只建一次。默认用 CPU；环境变量 `UI_PRO_ORT_EP=dml` 时试用 DirectML，失败就退回 CPU。

### 2. 抠取 `extract`

- `ui`：有 `hint` 时以它为初值修边；没有时在 `box` 内用轮廓或 GrabCut 求前景（先确认 opencv.js 4.9 这个构建里有 `grabCut`，没有就写进 Comments 并用别的办法）。然后在边界带上求柔边透明度，再去除边缘混入的背景色：用透明通道外一圈估计背景色 B，按 F = (I − (1 − α)·B) / α 还原前景色。
- `figure`：用 anime-seg 模型出遮罩，之后同样修边、去色边。
- `text`：位图文字用字形墨迹（含描边和阴影）做透明通道，可以复用 `ink.ts` 的边缘与墨迹方法。
- `style: 'pixel'`：硬边（透明度按 128 二值化），不做平滑。
- `method` 写实际用的方法：`hint`、`contour`、`grabcut`、`anime-seg`、`ink`。

### 3. 补全 `fill`

- **解析**：洞周围一圈是纯色或线性渐变（逐通道拟合平面，残差小）时直接解析填充，`tier: 'analytic'`。
- **本地**：LaMa。输入固定 512×512：在洞周围取一块带上下文的方形区域（洞的外接框放大 2–3 倍），缩放到 512，推理，缩回原尺寸，只在洞内贴回，边界羽化。`tier: 'local'`，`method: 'lama'`。
- **云端**：`quality: 'final'`、有云端图像模型、外发档位不是 `local` 时，按第 7 节的约束调用局部重绘。全部候选都被淘汰时退回本地结果并加一条警告，不报错。
- 无论哪一层，洞外的像素必须与输入完全相同（约束 1）。

### 4. 文字剥离 `stripText`

- 墨迹遮罩：调用方给了就用；没给就在 `box` 内自己算。外扩 2 像素作为补全区域。
- 量出文字样式：字形主体的颜色；描边的颜色和宽度（与主体颜色不同时才有）；阴影的颜色、偏移、模糊；从字形高度换算出的字号。都用请求图的像素。
- 然后按补全的三层填上文字原来的位置。云端用带遮罩的局部重绘，而不是不带遮罩的去文字功能，这样才能满足约束 1。

### 5. 提升分辨率 `upscale`

- **重采样**：倍数不超过 1.25，或像素风（用最近邻），直接用 sharp 缩放，`tier: 'resample'`。
- **本地**：realesr-animevideov3，4 倍。按 256×256 分块推理，块间重叠（例如 16 像素）并羽化拼接，再用 Lanczos 缩到目标倍数。透明通道单独用 Lanczos 放大。`tier: 'local'`。
- **云端**：`quality: 'final'` 时用超分，`upscale_factor` 取不小于倍数的整数（最大 4），再缩到目标尺寸。图小于 512 时先镜像外扩到 512，取回后裁掉外扩。服务只返回 RGB，透明通道沿用本地或重采样的结果。
- `fidelity`：结果缩回输入尺寸后，与输入在不透明像素上算结构相似度。低于阈值（例如 0.9，写成常量）就退回上一层，并加一条警告。

### 6. 云端图像模型：`createCloudImageModel`

- 只有 `provider: 'dashscope'` 且环境里有 `DASHSCOPE_API_KEY` 时才返回模型，否则返回 `null`。密钥只从环境变量读。
- 服务地址：`image_model.endpoint`；没有时用 `https://dashscope.aliyuncs.com`。
- 可以加一个可选参数注入 `fetch`，供测试使用。
- 只做原始的服务调用，不含项目知识；约束在第 7 节那一层实现。
- `capabilities`：`maskInput: true`、`transparentOutput: false`、`layerDecomposition: false`、`minSide: 512`、`maxSide: 4096`、`maxCandidates: 4`。

**接口事实**（2026-11-26 核对自[通义万相图像编辑 API 参考](https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference)）：

- 提交任务：`POST {base}/api/v1/services/aigc/image2image/image-synthesis`。请求头 `Authorization: Bearer <key>`、`Content-Type: application/json`、`X-DashScope-Async: enable`（必须，只支持异步）。
- 请求体：`{ model: 'wanx2.1-imageedit', input: { function, prompt, base_image_url, mask_image_url? }, parameters: { n, seed?, watermark: false, upscale_factor? } }`。
  - `function`：`description_edit_with_mask`（局部重绘，要 `mask_image_url`）、`remove_watermark`（去文字水印）、`super_resolution`（超分，`upscale_factor` 1–4）。
  - `prompt` 必填，不超过 800 字符。`n` 是 1–4。
  - 遮罩：纯白（255,255,255）是要重绘的部分，纯黑（0,0,0）是保留的部分，分辨率必须与原图相同。
  - 图片：公网 URL，或 `data:image/png;base64,...`；JPG、PNG、BMP、TIFF、WEBP；宽和高都在 512–4096 像素之间；不超过 10 MB。
- 响应：`{ output: { task_id, task_status }, request_id }`。
- 查询：`GET {base}/api/v1/tasks/{task_id}`，轮询到 `task_status` 为 `SUCCEEDED`、`FAILED`、`CANCELED` 或 `UNKNOWN`。结果在 `output.results[]`：每项是 `{ url }` 或 `{ code, message }`。结果地址 24 小时内有效，取到后立刻下载。
- 失败时 HTTP 4xx/5xx 带 `code`、`message`。限流时有限次退避重试；轮询要有总超时。
- 华北 2 推荐业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，用户在 `image_model.endpoint` 里配置。

### 7. 云端的八条约束

在 `PixelOps` 的云端这一层实现，对所有云端 Provider 生效：

1. **只取遮罩内的像素**：遮罩内用返回结果，边界处 2–4 像素过渡，遮罩外保留原像素。
2. **对齐校验**：返回图遮罩外的部分（缩回送出时的尺寸）与送出的像素比对；差异超过阈值，或检测到平移、缩放，这个候选作废。
3. **按原始像素密度送图**：按源文件的像素密度裁出目标区域加一圈上下文。不足 512 时先扩大上下文；整张源图都不够 512 时，用 Lanczos 放大到 512 再送，取回后缩回，并在警告里说明。不把整张图重采样后送出。
4. **颜色校正**：遮罩外一圈在结果与原图上的平均颜色（Lab）比对，色差超过阈值的作废。
5. **多候选择优**：一次要 `n` 个候选（默认 2，常量），按边界连续性（洞边界两侧的梯度是否衔接）和纹理一致性（洞内与周围一圈的统计量）打分，选最好的；其余通过 `store.put(output, alternatives)` 保留。
6. **锁定**：调用前先用请求键查 `store.get`，有就直接用、不调用服务；`store.allowNew` 为 false 且没有锁定输出时报 `E_NOT_LOCKED`。本地模型的输出同样走锁定。
7. **预算**：每次调用前 `log.count(screen)` 达到 `budget` 就报 `E_IMAGE_BUDGET`，由构建处理。
8. **外发记录**：每次调用 `log.append`：模型、用途、界面、节点、送出的每张图的 sha256、字节数。

外发档位：`local` 时 `PixelContext.cloud` 为 `null`；`hybrid` 只允许送局部裁片，按第 3 条本来就只送裁片；`cloud` 同样只送裁片，原因是保持像素密度。

## 验收

- 单元测试（合成图，不用模型）：
  - 渐变底上的柔边圆角矩形：抠取的透明度与真值的交并比不低于 0.95，半透明边缘没有背景色残留；
  - 位图文字的墨迹抠取；
  - 渐变上的洞解析填充结果准确；任何一层补全的洞外像素都不变；
  - `stripText` 在合成文字上量出的颜色和字号在容差内；
  - 重采样那一层的放大与 `fidelity`。
- `createModelStore`：用本地 HTTP 服务伪装模型下载站（`HF_ENDPOINT` 指向它，`UI_PRO_MODEL_DIR` 用临时目录，模型换成小文件）。覆盖：下载与进度、哈希不符时报 `E_MODEL_UNAVAILABLE` 且不留文件、第一个地址失败时用第二个、已下载过不再下载。
- 云端：用假的 `fetch` 模拟提交、轮询、取结果。覆盖：
  - 遮罩合成；
  - 平移过的结果被对齐校验淘汰；偏色结果被颜色校正淘汰；
  - 候选择优与落选候选的保留；
  - `E_IMAGE_BUDGET`；外发记录；
  - 已锁定时不调用服务；`allowNew` 为 false 时报 `E_NOT_LOCKED`；
  - 小于 512 的裁片被扩大后再送。
- 本地模型的集成测试（`*.integration.test.ts`，`UI_PRO_MODELS=1` 时才跑）：
  - 在糖果骑士的裁片上用真实的 LaMa 补全（例如去掉装备框上的“+5”）；
  - 用真实的 Real-ESRGAN 放大一个图标；
  - 用真实的 anime-seg 抠出角色。

  输出存到 `.scratch/m1-batch3/ref/pixel/`，父 agent 会看图。
- 真实云端测试只在 `UI_PRO_CLOUD=1` 且有密钥时跑：一次局部重绘。
- 在 Comments 里报告：首次下载各模型的耗时、每次推理的耗时（CPU，本机）、`grabCut` 是否可用、`catalog.ts` 里核实后更正了什么。
