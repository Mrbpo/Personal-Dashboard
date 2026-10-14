// Independent formula expectations, visually transcribed from original PDF pages.
// The page field is the 1-based PDF page, not a printed chapter/slide number.
// These samples are fixed before any AI request; equivalent valid LaTeX is accepted.
export const pdfFormulaSamples = [
  {
    path: 'probability-01.pdf',
    page: 3,
    formulae: [
      String.raw`P(A\cap B)=P(A\mid B)\cdot P(B)`,
      String.raw`P(S_2\mid S_1)=\frac{12}{51}`,
      String.raw`P(S_1\cap S_2)=\frac{13\cdot12}{52\cdot51}=\frac{3}{51}`,
    ],
    notes: 'Visually checked probability-01-page3.png, original printed page 3. Multiplication Rule equation (2), conditional spade probability, and the two-card joint probability. Preserve event subscripts, intersection versus conditioning, and both fraction denominators. An equivalent 12/51 form is sufficient for the conditional probability; longer correct derivation chains are allowed.',
  },
  {
    path: 'numerical-02.pdf',
    page: 3,
    formulae: [
      String.raw`I_h=\sum_{i=1}^{N-1}f(x_i)\,h`,
      String.raw`h=\frac{b-a}{N-1}`,
      String.raw`\varepsilon_i=\frac{1}{2}|m|h^2`,
      String.raw`|I-I_h|\le\sum_{i=1}^{N-1}\varepsilon_i\le\sum_{i=1}^{N-1}\varepsilon_{\max}=(N-1)\varepsilon_{\max}`,
    ],
    notes: 'Visually checked numerical-02-page3-reference.png. Handwritten four-up slide page containing printed slides 9-12. First formula is the left-endpoint rectangle rule, not the midpoint rule. Mesh width and global-error chain appear in slide 11; triangular local error for f(x)=mx+c appears in slide 12. Require N-1 bounds, absolute m, square on h, subscripts, and inequality directions. Lowercase/uppercase epsilon or equivalent LaTeX formatting is acceptable; avoid treating N quadrature points as the N-1 intervals.',
  },
  {
    path: 'mechanics-05.pdf',
    page: 6,
    formulae: [
      String.raw`K\equiv\frac{1}{2}mv^2`,
      String.raw`\Delta K=\frac{1}{2}mv_f^2-\frac{1}{2}mv_i^2`,
    ],
    notes: 'Visually checked mechanics-05-page6-reference.png, printed chapter page 13-5. Kinetic Energy equations (13.2.1) and (13.2.2). Require the factor one-half, squared speeds, final/initial subscripts, and subtraction order. K= instead of K≡ is a semantically acceptable definition; do not confuse PDF page 6 with printed page 5.',
  },
];

export default pdfFormulaSamples;
