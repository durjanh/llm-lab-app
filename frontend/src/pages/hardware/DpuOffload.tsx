import { useState, type CSSProperties } from 'react';
import './dpu.css';

// Illustrative assumptions, shown on screen. Real figures vary with the CPU, the protocol and the software stack.
const CORES = 32; // host CPU cores
const FEED = 16; // cores needed to keep the GPU fully fed (data loading, preprocessing, launching work)
const GBPS_PER_CORE_NET = 10; // encrypted network traffic one core can handle (TCP + TLS/IPsec)
const GBPS_PER_CORE_STORAGE = 25; // remote storage I/O one core can handle (NVMe over Fabrics)
const DPU_GBPS = 400; // line rate of a current DPU, such as BlueField-3
const HOST_CONTROL = 0.5; // cores the host still spends managing the DPU

function model(net: number, storage: number, dpu: boolean) {
  if (dpu) {
    const total = net + storage;
    const dpuLoad = total / DPU_GBPS;
    const infra = HOST_CONTROL;
    const app = CORES - infra;
    const gpu = Math.min(1, app / FEED) * Math.min(1, DPU_GBPS / Math.max(total, 1));
    return { infra, app, gpu, dpuLoad, served: Math.min(total, DPU_GBPS) };
  }
  const demand = net / GBPS_PER_CORE_NET + storage / GBPS_PER_CORE_STORAGE;
  const infra = Math.min(CORES, demand);
  const app = CORES - infra;
  const gpu = Math.min(1, app / FEED);
  const served = demand > CORES ? (net + storage) * (CORES / demand) : net + storage;
  return { infra, app, gpu, dpuLoad: 0, served };
}

/** An illustrative simulation of why DPUs exist: infrastructure work competes with the work of feeding the GPU. */
export default function DpuOffload() {
  const [dpu, setDpu] = useState(false);
  const [net, setNet] = useState(150);
  const [storage, setStorage] = useState(80);
  const m = model(net, storage, dpu);
  const feeding = Math.min(m.app, FEED);
  const free = m.app - feeding;
  const dots = Math.max(1, Math.min(18, Math.round((net + storage) / 15)));

  return (
    <section className="hw-section">
      <h2>DPUs: taking infrastructure work off the CPU</h2>
      <p>
        In an AI cluster, a server's CPUs do two jobs: the infrastructure work of moving data (networking, encryption, remote
        storage) and the application work of feeding the GPUs. A DPU (data processing unit) is a processor on the network card
        with its own cores and accelerators, so the infrastructure work happens there instead. Raise the traffic and switch the
        DPU on and off.
      </p>
      <p className="dp-badge small">Illustrative simulation: a simple model with the assumptions listed below, not a measurement.</p>

      <div className="hw-controls">
        <div className="chips" role="radiogroup" aria-label="DPU">
          <button className={`chip-btn ${!dpu ? 'on' : ''}`} onClick={() => setDpu(false)}>
            Without a DPU
          </button>
          <button className={`chip-btn ${dpu ? 'on' : ''}`} onClick={() => setDpu(true)}>
            With a DPU
          </button>
        </div>
        <label>
          Encrypted network <input type="range" min={0} max={300} step={10} value={net} onChange={(e) => setNet(+e.target.value)} />
          <span className="mono">{net} Gb/s</span>
        </label>
        <label>
          Remote storage <input type="range" min={0} max={200} step={10} value={storage} onChange={(e) => setStorage(+e.target.value)} />
          <span className="mono">{storage} Gb/s</span>
        </label>
      </div>

      <svg className="dp-svg" viewBox="0 0 760 210" role="img" aria-label={dpu ? 'Traffic handled by the DPU' : 'Traffic handled by the host CPU'}>
        <defs>
          <marker id="dp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" className="dp-arrowhead" />
          </marker>
        </defs>
        <g className="dp-box">
          <rect x="10" y="70" width="120" height="70" rx="10" />
          <text x="70" y="92" textAnchor="middle" className="dp-title">Network</text>
          <text x="70" y="108" textAnchor="middle" className="dp-sub">and storage</text>
        </g>
        <g className={`dp-box ${dpu ? 'dpu' : ''}`}>
          <rect x="210" y="70" width="130" height="70" rx="10" />
          <text x="275" y="92" textAnchor="middle" className="dp-title">{dpu ? 'DPU' : 'Network card'}</text>
          <text x="275" y="108" textAnchor="middle" className="dp-sub">{dpu ? 'own cores + crypto' : 'just passes packets on'}</text>
        </g>
        <g className="dp-box">
          <rect x="420" y="20" width="170" height="170" rx="10" />
          <text x="505" y="40" textAnchor="middle" className="dp-title">CPU · {CORES} cores</text>
          {Array.from({ length: CORES }, (_, i) => {
            const kind = i < Math.round(m.infra) ? 'infra' : i < Math.round(m.infra + feeding) ? 'feed' : 'free';
            return <rect key={i} x={438 + (i % 8) * 18} y={56 + Math.floor(i / 8) * 30} width={14} height={24} rx={3} className={`dp-core ${kind}`} />;
          })}
        </g>
        <g className="dp-box">
          <clipPath id="dp-gpu-clip">
            <rect x="640" y="50" width="110" height="110" rx="10" />
          </clipPath>
          <rect x="640" y="50" width="110" height="110" rx="10" />
          <rect x="640" y={50 + 110 * (1 - m.gpu)} width="110" height={110 * m.gpu} clipPath="url(#dp-gpu-clip)" className="dp-gpu-fill" />
          <text x="695" y="98" textAnchor="middle" className="dp-title">GPU</text>
          <text x="695" y="118" textAnchor="middle" className="dp-sub">{Math.round(m.gpu * 100)}% busy</text>
        </g>
        <path d="M130 126 H210" className="dp-line" markerEnd="url(#dp-arrow)" />
        <path d={dpu ? 'M340 92 C 420 -10, 600 -10, 655 50' : 'M340 126 H420'} className="dp-line" markerEnd="url(#dp-arrow)" />
        <path d="M590 105 H640" className="dp-line" markerEnd="url(#dp-arrow)" />
        {/* packets: without a DPU they travel on into the CPU; with one they stop at the DPU */}
        {Array.from({ length: dots }, (_, i) => (
          <circle
            key={`${dpu}-${i}`}
            cx="130"
            cy={i % 2 ? 122 : 131}
            r="4"
            className={`dp-packet ${i % 3 === 0 ? 'storage' : 'net'}`}
            style={{ '--dx': dpu ? '140px' : '320px', animationDelay: `${(i * 2.4) / dots}s` } as CSSProperties}
          />
        ))}
      </svg>

      <div className="dp-bars">
        <Bar label="CPU on infrastructure (network, encryption, storage)" value={m.infra / CORES} text={`${m.infra.toFixed(1)} of ${CORES} cores`} kind="infra" />
        <Bar label="CPU feeding the GPU" value={feeding / CORES} text={`${feeding.toFixed(1)} cores (${FEED} needed)`} kind="feed" />
        <Bar label="CPU free" value={free / CORES} text={`${free.toFixed(1)} cores`} kind="free" />
        <Bar label="GPU busy" value={m.gpu} text={`${Math.round(m.gpu * 100)}%`} kind="gpu" />
        {dpu && <Bar label="DPU load" value={Math.min(1, m.dpuLoad)} text={`${Math.round(m.dpuLoad * 100)}% of ${DPU_GBPS} Gb/s`} kind="dpu" />}
        <p className="small muted">
          Traffic handled: {Math.round(m.served)} of {net + storage} Gb/s
          {m.served < net + storage ? (dpu ? ' (the DPU is at its line rate)' : ' (the CPU cannot keep up)') : ''}.
        </p>
      </div>

      <div className="dp-notes small">
        <p>
          <b>Assumptions in this model:</b> about one core per {GBPS_PER_CORE_NET} Gb/s of encrypted network traffic and one per{' '}
          {GBPS_PER_CORE_STORAGE} Gb/s of remote storage I/O; {FEED} cores keep the GPU fully fed; the DPU handles up to {DPU_GBPS}{' '}
          Gb/s and the host keeps {HOST_CONTROL} core to manage it. Real costs depend on the CPU, protocols and drivers.
        </p>
        <p>
          <b>Real examples:</b> NVIDIA BlueField (also moves data straight to GPU memory with GPUDirect), AMD Pensando, and AWS Nitro,
          which runs networking, storage and security for every modern EC2 instance. Besides freeing cores, a DPU isolates the
          infrastructure from the tenant's code, which matters for security in shared clouds.
        </p>
      </div>
    </section>
  );
}

function Bar({ label, value, text, kind }: { label: string; value: number; text: string; kind: string }) {
  return (
    <div className="dp-bar">
      <div className="dp-bar-head">
        <span>{label}</span>
        <span className="mono">{text}</span>
      </div>
      <div className="dp-track">
        <div className={`dp-fill ${kind}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </div>
    </div>
  );
}
