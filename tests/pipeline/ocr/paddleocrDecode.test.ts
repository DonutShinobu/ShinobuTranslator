import { describe, it, expect } from 'vitest';
import { decodePaddleCtc } from '../../../src/pipeline/ocr/paddleocrDecode';

describe('decodePaddleCtc', () => {
  it('解码简单的 CTC 输出：重复合并 + blank 去除', () => {
    // 3 个时间步，5 个字符类 (blank=0, A=1, B=2, C=3, D=4)
    const logits = new Float32Array([
      0.8, 0.1, 0.05, 0.03, 0.02,  // t0: blank
      0.1, 0.8, 0.05, 0.03, 0.02,  // t1: A
      0.1, 0.05, 0.8, 0.03, 0.02,  // t2: B
    ]);
    const result = decodePaddleCtc(logits, 3, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('AB');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('连续相同字符不合并（blank 间隔应保留重复）', () => {
    // t0: A, t1: blank, t2: A → "AA"
    const logits = new Float32Array([
      0.1, 0.9, 0.0, 0.0, 0.0,
      0.9, 0.1, 0.0, 0.0, 0.0,
      0.1, 0.9, 0.0, 0.0, 0.0,
    ]);
    const result = decodePaddleCtc(logits, 3, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('AA');
  });

  it('连续相同字符无 blank 间隔应合并', () => {
    // t0: A, t1: A → 合并为 "A"
    const logits = new Float32Array([
      0.1, 0.9, 0.0, 0.0, 0.0,
      0.1, 0.9, 0.0, 0.0, 0.0,
    ]);
    const result = decodePaddleCtc(logits, 2, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('A');
  });

  it('纯 blank 输出返回空字符串', () => {
    const logits = new Float32Array([
      0.9, 0.1, 0.0, 0.0, 0.0,
      0.9, 0.1, 0.0, 0.0, 0.0,
    ]);
    const result = decodePaddleCtc(logits, 2, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('');
  });

  it('置信度是几何平均概率', () => {
    // 一步：A 概率 0.8
    const logits = new Float32Array([
      0.2, 0.8, 0.0, 0.0, 0.0,
    ]);
    const result = decodePaddleCtc(logits, 1, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('A');
    expect(result.confidence).toBeCloseTo(0.8, 1);
  });
});
