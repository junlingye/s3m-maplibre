/**
 * GPU 后端抽象（#49 第 1 步）。
 *
 * 把「造 three renderer + 探测后端能力」从 `S3MViewer` 里抽出来，作为宿主无关的接缝：
 * 内核只认 `GpuBackend`，不再自己 `new THREE.WebGLRenderer`。这一步只落地 WebGL ——
 * WebGPU 后端（材质 TSL、深度写回、离屏 pass、异步拾取，见 issue #49 第 2~6 步）
 * 之后补一个 `GpuBackend` 实现即可，适配层与 `S3MViewer` 的生命周期都不用动。
 *
 * 接口承担四项职责（issue #49 原文）：创建 renderer / 查能力 / 回读 / 监听失效。
 * 第 1 步只接前两项：
 *   - 「创建 renderer」→ `createRenderer()`
 *   - 「查能力」→ `syncTextureCapabilities()`（DXT 压缩直传；其余能力探测复用 gpuCaps.ts）
 * 「回读」（Picker，第 5 步）与「监听失效的异步路径」（WebGPU，第 4 步）现在还不接线，
 * 留到各自所属步骤再扩接口，避免先开一个空方法逼后续步骤迁就它。
 *
 * 版本兼容（不要为了 WebGPU 抬高 peer 下限）：本模块**不在顶层 `import 'three/webgpu'`**。
 * WebGL1（peer 允许的 r155~r162）下 `WebGLBackend` 照常工作，回退逻辑留在适配层。
 */
import * as THREE from 'three';
import { setCompressedTexturesSupported } from './TextureFactory.js';

export type GpuBackendKind = 'webgl' | 'webgpu';

/** 造 renderer 时可从外部注入的调节项（由 `S3MViewer.options` 投影而来） */
export interface WebGLRendererInit {
  toneMapping?: THREE.ToneMapping;
  toneMappingExposure?: number;
}

/**
 * 宿主无关的 GPU 后端。`S3MViewer` 在 mount / 上下文恢复时只跟这个接口打交道。
 */
export interface GpuBackend {
  /** 后端类型；能力探测与回读策略据此分流 */
  readonly kind: GpuBackendKind;
  /** 在宿主 canvas 上创建一个已配置好的 three renderer */
  createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer;
  /** 把后端特有的纹理能力同步到渲染模块（WebGL：DXT 压缩直传开关） */
  syncTextureCapabilities(): void;
}

/** `applyWebGLRendererInit` 需要的最小 renderer 形态（便于用假对象做单测） */
export interface WebGLRendererLike {
  autoClear: boolean;
  setPixelRatio(ratio: number): void;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
}

/**
 * 新建 renderer 后的统一配置。从改造前的 `S3MViewer._createRenderer` 里**逐字搬过来**：
 * 关自动清屏（深度/颜色由宿主与本层分别管）、像素比固定 1（宿主已按物理像素给 canvas）、
 * 色调映射默认 `NoToneMapping`（保留材质与底图原色，不被 ACES 压暗）。
 */
export function applyWebGLRendererInit(renderer: WebGLRendererLike, init: WebGLRendererInit): void {
  renderer.autoClear = false;
  renderer.setPixelRatio(1);
  renderer.toneMapping = init.toneMapping !== undefined ? init.toneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = init.toneMappingExposure ?? 1.0;
}

/**
 * DXT 压缩纹理直传的判据：`WEBGL_compressed_texture_s3tc` 与 `..._srgb` **两个都要在**。
 *
 * 纯函数（不碰全局），单测钉死这条 AND 逻辑 —— 缺 srgb 变体时贴图会发白失配，
 * 所以不能只看其中一个。`S3MViewer` 改造前后都用这一条口径。
 */
export function webglCompressedTexturesSupported(
  gl: { getExtension?: (name: string) => unknown } | null | undefined,
): boolean {
  if (!gl || typeof gl.getExtension !== 'function') return false;
  const s3tc = !!gl.getExtension('WEBGL_compressed_texture_s3tc');
  const s3tcSrgb = !!gl.getExtension('WEBGL_compressed_texture_s3tc_srgb');
  return s3tc && s3tcSrgb;
}

/** 鸭子类型判定：是否是一个 `GpuBackend`（而不是宿主传进来的裸 WebGL 上下文）。 */
export function isGpuBackend(v: unknown): v is GpuBackend {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    'createRenderer' in v &&
    'syncTextureCapabilities' in v
  );
}

/**
 * WebGL 后端：复用宿主已有的 GL 上下文（`context: gl`），不自建画布。
 *
 * `gl` 与 `init` 留作公开只读，便于单测断言「裸 gl 被原样接管、配置被透传」。
 */
export class WebGLBackend implements GpuBackend {
  readonly kind = 'webgl' as const;
  constructor(
    readonly gl: WebGLRenderingContext | WebGL2RenderingContext,
    readonly init: WebGLRendererInit = {},
  ) {}

  createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
    const r = new THREE.WebGLRenderer({
      canvas,
      context: this.gl as WebGLRenderingContext,
      antialias: true,
    });
    applyWebGLRendererInit(r, this.init);
    return r;
  }

  syncTextureCapabilities(): void {
    setCompressedTexturesSupported(webglCompressedTexturesSupported(this.gl));
  }
}

/**
 * 归一化宿主的挂载输入：
 *   - 已经是 `GpuBackend` → 原样返回（同一引用）；
 *   - 裸 WebGL 上下文 → 包成 `WebGLBackend`，`init` 由调用方从 viewer 选项投影。
 *
 * 这条归一化让 `mount(canvas, gl)` 的旧调用路径在不变式①下行为不变：包出来的
 * `WebGLBackend.createRenderer` 与改造前 `_createRenderer` 逐字等价。
 */
export function resolveBackend(
  glOrBackend: WebGLRenderingContext | WebGL2RenderingContext | GpuBackend,
  init: WebGLRendererInit = {},
): GpuBackend {
  if (isGpuBackend(glOrBackend)) return glOrBackend;
  return new WebGLBackend(glOrBackend, init);
}
