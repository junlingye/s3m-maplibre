/**
 * 单元测试：后端抽象 `GpuBackend`（#49 第 1 步）。
 *
 * 这一步只做「把 renderer 的创建与能力探测从 S3MViewer 里抽到一个宿主无关的接口后面」，
 * 不接 WebGPU（那是第 2~6 步）。所以测试钉两件事：
 *
 * 1. **不变式①**：宿主照旧传一个裸 WebGL 上下文时，包出来的 `WebGLBackend` 造出来的
 *    renderer 配置必须与改造前 `S3MViewer._createRenderer` 逐字一致；能力探测（DXT 直传）
 *    判据也不能漂移。
 * 2. **新接缝**：`mount(canvas, backend)` / `restoreContext(backend)` 能接收任意
 *    `GpuBackend`，renderer 完全由 backend 造，viewer 不再自己 `new THREE.WebGLRenderer`。
 *
 * 不依赖真实 WebGL：raw-gl 路径只验配置计算（纯函数），真正构造 `THREE.WebGLRenderer`
 * 留到浏览器；backend 路径用桩 renderer 验接线。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  type GpuBackend,
  WebGLBackend,
  resolveBackend,
  isGpuBackend,
  applyWebGLRendererInit,
  webglCompressedTexturesSupported,
} from '../../packages/s3m-three/src/render/gpuBackend';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

/** 记录 getExtension 调用的假 GL（不需要真上下文） */
function fakeGl(extensions: string[] = []) {
  const probed: string[] = [];
  const gl = {
    _probed: probed,
    getExtension(name: string) {
      probed.push(name);
      return extensions.includes(name) ? {} : null;
    },
  };
  return gl as unknown as WebGLRenderingContext & { _probed: string[] };
}

describe('webglCompressedTexturesSupported', () => {
  test('两个 s3tc 扩展都在才放行', () => {
    expect(
      webglCompressedTexturesSupported(
        fakeGl(['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb']) as never,
      ),
    ).toBe(true);
  });

  test('缺 srgb 变体不放行（贴图会发白失配）', () => {
    expect(webglCompressedTexturesSupported(fakeGl(['WEBGL_compressed_texture_s3tc']) as never)).toBe(false);
  });

  test('缺 s3tc 不放行', () => {
    expect(webglCompressedTexturesSupported(fakeGl(['WEBGL_compressed_texture_s3tc_srgb']) as never)).toBe(false);
  });

  test('空 gl / null 不猜，按不支持处理', () => {
    expect(webglCompressedTexturesSupported(null)).toBe(false);
    expect(webglCompressedTexturesSupported(undefined)).toBe(false);
    expect(webglCompressedTexturesSupported({} as never)).toBe(false);
  });
});

describe('applyWebGLRendererInit —— 与改造前逐字一致', () => {
  test('默认：关自动清屏、像素比 1、NoToneMapping、曝光 1', () => {
    const r = { autoClear: true, pixelRatio: 99, toneMapping: 'ACESFilmic', toneMappingExposure: 5 } as never as {
      autoClear: boolean;
      setPixelRatio(n: number): void;
      _pr: number;
      toneMapping: unknown;
      toneMappingExposure: number;
    };
    // setPixelRatio 记录到 _pr，方便断言
    (r as { setPixelRatio(n: number): void }).setPixelRatio = function (n: number) {
      (r as { _pr: number })._pr = n;
    };
    applyWebGLRendererInit(r as never, {});
    expect(r.autoClear).toBe(false);
    expect(r._pr).toBe(1);
    expect(r.toneMapping).toBe(THREE.NoToneMapping);
    expect(r.toneMappingExposure).toBe(1);
  });

  test('显式 toneMapping / exposure 透传', () => {
    const r = {
      autoClear: true,
      setPixelRatio() {},
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
    } as never;
    applyWebGLRendererInit(r, { toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.5 });
    expect((r as { toneMapping: unknown }).toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect((r as { toneMappingExposure: number }).toneMappingExposure).toBe(0.5);
  });
});

describe('resolveBackend', () => {
  test('裸 gl → WebGLBackend，且持有原 gl', () => {
    const gl = fakeGl();
    const b = resolveBackend(gl);
    expect(b.kind).toBe('webgl');
    expect(b).toBeInstanceOf(WebGLBackend);
    expect((b as WebGLBackend).gl).toBe(gl);
  });

  test('init 透传进 WebGLBackend', () => {
    const gl = fakeGl();
    const b = resolveBackend(gl, { toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 2 }) as WebGLBackend;
    expect(b.init.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(b.init.toneMappingExposure).toBe(2);
  });

  test('已经是 GpuBackend → 原样返回（同一引用）', () => {
    const custom: GpuBackend = { kind: 'webgpu', createRenderer: () => null as never, syncTextureCapabilities: () => {} };
    expect(resolveBackend(custom)).toBe(custom);
  });
});

describe('isGpuBackend', () => {
  test('识别鸭子类型的 backend', () => {
    expect(isGpuBackend({ kind: 'webgl', createRenderer() {}, syncTextureCapabilities() {} })).toBe(true);
  });
  test('拒绝裸 gl / 空对象 / 缺方法 / 非对象', () => {
    expect(isGpuBackend(fakeGl())).toBe(false);
    expect(isGpuBackend({})).toBe(false);
    expect(isGpuBackend({ kind: 'webgl', createRenderer() {} })).toBe(false);
    expect(isGpuBackend(null)).toBe(false);
    expect(isGpuBackend(0)).toBe(false);
  });
});

describe('WebGLBackend.syncTextureCapabilities', () => {
  test('同时探测两个 s3tc 扩展', () => {
    const gl = fakeGl(['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb']);
    new WebGLBackend(gl).syncTextureCapabilities();
    expect(gl._probed).toContain('WEBGL_compressed_texture_s3tc');
    expect(gl._probed).toContain('WEBGL_compressed_texture_s3tc_srgb');
  });
});

/** 桩 backend：返回一个只够 viewer.mount 用到的假 renderer，记录调用次数 */
function stubBackend() {
  const fakeRenderer = {
    capabilities: { getMaxAnisotropy: () => 1, isWebGL2: true },
    extensions: { has: () => true },
    getContext: () => null,
    domElement: {},
    dispose() {},
    setViewport() {},
    render() {},
    resetState() {},
  };
  const state = { createCalls: 0, syncCalls: 0, renderer: fakeRenderer };
  const backend: GpuBackend = {
    kind: 'webgl',
    createRenderer() {
      state.createCalls++;
      return state.renderer as never;
    },
    syncTextureCapabilities() {
      state.syncCalls++;
    },
  };
  return { backend, state };
}

describe('S3MViewer 接线 —— mount/restoreContext 走 backend，不再自建 renderer', () => {
  function makeViewer() {
    return new S3MViewer({ canvas: null as never, container: null as never } as never);
  }
  const fakeCanvas = {
    getContext: () => null,
    width: 100,
    height: 100,
    clientWidth: 100,
    clientHeight: 100,
  } as unknown as HTMLCanvasElement;

  test('mount(canvas, backend)：renderer 由 backend 造、能力探测各一次、记进 _backend', () => {
    const viewer = makeViewer();
    const { backend, state } = stubBackend();
    viewer.mount(fakeCanvas, backend);
    expect(state.createCalls).toBe(1);
    expect(state.syncCalls).toBe(1);
    expect(viewer.renderer).toBe(state.renderer);
    expect((viewer as unknown as { _backend: GpuBackend | null })._backend).toBe(backend);
    viewer.dispose();
  });

  test('restoreContext(backend)：换新 renderer 也走 backend，不重新 mount 场景', () => {
    const viewer = makeViewer();
    const { backend, state } = stubBackend();
    viewer.mount(fakeCanvas, backend);
    const sceneAfterMount = viewer.scene;
    const before = state.createCalls;
    viewer.restoreContext(backend);
    expect(state.createCalls).toBe(before + 1);
    expect(viewer.scene).toBe(sceneAfterMount); // 保留已加载场景
    viewer.dispose();
  });
});
