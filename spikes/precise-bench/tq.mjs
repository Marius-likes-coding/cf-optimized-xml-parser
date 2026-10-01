// Student-t quantile via the regularized incomplete beta function (Numerical Recipes betacf).
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const value of c) ser += value / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 / (1 + aa * d);
    c = 1 + aa / c;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** P(T <= t) for Student's t with df degrees of freedom. */
export function tCdf(t, df) {
  const tail = 0.5 * betai(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - tail : tail;
}
/** Quantile p of Student's t with df degrees of freedom (bisection). */
export function tQuantile(p, df) {
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
