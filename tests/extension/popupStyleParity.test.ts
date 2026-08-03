import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const popupStyles = readFileSync(resolve('src/popup/styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = popupStyles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'u'));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1].replace(/\s+/gu, ' ').trim() ?? '';
}

describe('popup browser style parity', () => {
  it('neutralizes Firefox native range styling behind the custom thinking slider', () => {
    const track = declarationsFor('.thinking-slider::-moz-range-track');
    expect(track).toContain('height: 16px');
    expect(track).toContain('border: 0');
    expect(track).toContain('background: transparent');

    const progress = declarationsFor('.thinking-slider::-moz-range-progress');
    expect(progress).toContain('height: 16px');
    expect(progress).toContain('border: 0');
    expect(progress).toContain('background: transparent');

    const thumb = declarationsFor('.thinking-slider::-moz-range-thumb');
    expect(thumb).toContain('width: 20px');
    expect(thumb).toContain('height: 20px');
    expect(thumb).toContain('border: 0');
    expect(thumb).toContain('background: transparent');
    expect(thumb).toContain('opacity: 0');
  });
});
