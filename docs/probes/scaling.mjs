// 纯 JS 暴力余弦的可扩展性：决定要不要引入 sqlite-vec
const D = 384
const rand = () => { const v = new Float32Array(D); for (let i=0;i<D;i++) v[i]=Math.random()*2-1; let n=0; for(const x of v) n+=x*x; n=Math.sqrt(n); for(let i=0;i<D;i++) v[i]/=n; return v }
function dot(a,b){ let s=0; for(let i=0;i<D;i++) s+=a[i]*b[i]; return s }
for (const N of [100, 1000, 5000, 20000]) {
  const vecs = Array.from({length:N}, rand)
  const q = rand()
  // warm
  for (let i=0;i<3;i++) for (const v of vecs) dot(q,v)
  const t0 = process.hrtime.bigint()
  const R = 20
  for (let r=0;r<R;r++) for (const v of vecs) dot(q,v)
  const t1 = process.hrtime.bigint()
  const per = Number(t1-t0)/1e6/R
  const bytes = N*D*4
  console.log(`N=${String(N).padStart(6)}  brute-force cos: ${per.toFixed(2)} ms/query   raw f32 ${(bytes/1024/1024).toFixed(2)} MB`)
}
// 量化存储：Int8 量化的精度损失
const a = rand(), b = rand()
let d=0; for(let i=0;i<D;i++) d+=a[i]*b[i]
const qa = Int8Array.from(a, x => Math.round(x*127)), qb = Int8Array.from(b, x => Math.round(x*127))
let dq=0; for(let i=0;i<D;i++) dq+=qa[i]*qb[i]
console.log(`\ncos f32=${d.toFixed(4)}  cos int8(未归一)≈${(dq/(127*127)).toFixed(4)}`)
