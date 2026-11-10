// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Tests run on a desktop-sized screen (P59): jsdom reports the page as 0 pixels wide, which the
// design system would take for a phone. A test can call `screenWidth(390)` for a phone.

let width = 1280;

Object.defineProperty(document.documentElement, 'clientWidth', {
  configurable: true,
  get: () => width,
});

export function screenWidth(px: number): void {
  width = px;
  window.dispatchEvent(new Event('resize'));
}
