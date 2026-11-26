import type { Project } from '@ui-pro/core';
import type { RenderSession } from '@ui-pro/renderer';
import { GATE_NAMES, type GateResult } from '../types';

/**
 * 引擎一致 (DESIGN §13.1): exports the screen to a scratch Godot project, screenshots it with
 * rendering on, and compares the shot with the reference renderer's frame at the same size.
 * Skipped, not failed, when Godot is not installed.
 */
export async function runEngineGate(
  _project: Project,
  _screen: string,
  _render: RenderSession,
): Promise<GateResult> {
  return {
    id: 'engine',
    name: GATE_NAMES.engine,
    status: 'skipped',
    reason: '尚未实现（第 3 批工单 09）',
    metrics: {},
    problems: [],
    warnings: [],
    views: [],
  };
}
