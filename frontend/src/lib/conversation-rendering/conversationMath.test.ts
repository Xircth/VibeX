import { describe, expect, it } from 'vitest';
import { protectConversationMath } from './conversationMath';

describe('protectConversationMath', () => {
  it('extracts inline and display dollar math', () => {
    const next = protectConversationMath(
      String.raw`Euler $e^{i\pi}+1=0$

$$
\int_0^1 x^2 dx
$$`
    );

    expect(next.math).toEqual([
      { tex: String.raw`e^{i\pi}+1=0`, display: false },
      { tex: String.raw`\int_0^1 x^2 dx`, display: true },
    ]);
    expect(next.text).toContain('\uE000MATH0\uE000');
    expect(next.text).toContain('\uE000MATH1\uE000');
    expect(next.text).not.toContain('\\int');
  });

  it('extracts MathJax \\[ \\] display math used by non-KaTeX agents', () => {
    const next =
      protectConversationMath(String.raw`假设三段轨迹的持续时间分别为：

\[
T_0 = 2\text{s} \qquad T_1 = 3s \qquad T_2 = s
\]

总时间为：`);

    expect(next.math).toHaveLength(1);
    expect(next.math[0]).toEqual({
      tex: String.raw`T_0 = 2\text{s} \qquad T_1 = 3s \qquad T_2 = s`,
      display: true,
    });
    expect(next.text).not.toContain('\\text');
    expect(next.text).not.toContain('\\qquad');
    expect(next.text).not.toContain('\\[');
  });

  it('extracts \\( \\) inline math and bare align environments', () => {
    const next = protectConversationMath(
      String.raw`Inline \(a+b\)

\begin{aligned}
T_0 &= 2\text{s} \\
T_1 &= 3s
\end{aligned}`
    );

    expect(next.math).toEqual([
      { tex: 'a+b', display: false },
      {
        tex: String.raw`\begin{aligned}
T_0 &= 2\text{s} \\
T_1 &= 3s
\end{aligned}`,
        display: true,
      },
    ]);
  });

  it('renders fenced math/latex as display TeX and leaves other fences alone', () => {
    const next = protectConversationMath(
      String.raw`Before

` + '```math\nT = T_0 + T_1\n```\n\n```ts\nconst raw = "$not math$";\n```'
    );

    expect(next.math).toEqual([{ tex: 'T = T_0 + T_1', display: true }]);
    expect(next.text).toContain('const raw = "$not math$"');
    expect(next.text).not.toContain('```math');
  });

  it('does not treat currency or unmatched dollars as math', () => {
    const next = protectConversationMath('It costs $20 and $30 today.');
    expect(next.math).toEqual([]);
    expect(next.text).toBe('It costs $20 and $30 today.');
  });
});
