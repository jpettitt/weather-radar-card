// The editor's "Labels above the radar" switch: on is the default, so it
// leaves vector_labels out of the YAML; off writes vector_labels: below.

import { describe, it, expect } from 'vitest';
import * as editorModule from '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

const proto = (Object.values(editorModule).find((v: any) => typeof v === 'function' && v.prototype?._vectorLabelsChanged) as any).prototype;

const toggle = (config: Record<string, unknown>, checked: boolean): Record<string, unknown> => {
  const fired: any[] = [];
  const editor = { _config: config, dispatchEvent: (e: CustomEvent) => fired.push(e.detail.config) };
  proto._vectorLabelsChanged.call(editor, { target: { checked } });
  expect(fired).toHaveLength(1);
  return fired[0];
};

describe('labels-above switch', () => {
  it('writes vector_labels: below when switched off', () => {
    expect(toggle({ map_style: 'MapTilesVector' }, false)).toEqual({ map_style: 'MapTilesVector', vector_labels: 'below' });
  });

  it('removes the key when switched back on', () => {
    expect(toggle({ map_style: 'MapTilesVector', vector_labels: 'below' }, true)).toEqual({ map_style: 'MapTilesVector' });
  });
});
