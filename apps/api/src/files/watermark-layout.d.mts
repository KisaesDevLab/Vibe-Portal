// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Placement {
  x: number;
  y: number;
  size: number;
  angle: number;
}
export const MARK_ANGLE: number;
export function markLayout(box: Box, rotation: number, widthAtOne: number): Placement;
export function markCorners(at: Placement, widthAtOne: number): Array<[number, number]>;
