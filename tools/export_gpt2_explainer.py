#!/usr/bin/env python3
"""Export GPT-2 small to ONNX with its internal activations as outputs.

The standard browser build of GPT-2 only returns logits. This script builds a
model that also returns every value the Transformer Explainer page draws:
token and position embeddings, per-layer Q, K and V, attention probabilities,
the attention projection, residuals, layer-norm outputs, the MLP before and
after its projection, block outputs, the final layer-norm state and the logits
for the last position.

It runs GPT-2's own weights (openai-community/gpt2) in a small PyTorch module,
checks that module against the Hugging Face reference, exports it with
torch.onnx.export, stores the weights in 8 bits with onnxruntime's MatMulNBits
quantizer and checks the result again. The output goes to models/gpt2-explainer/ with a manifest.

Usage (see tools/README.md):
    python tools/export_gpt2_explainer.py
    python tools/export_gpt2_explainer.py --out models/gpt2-explainer --work /tmp/gpt2x
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import sys
import tempfile
import time

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
from transformers import AutoTokenizer, GPT2LMHeadModel

MODEL_ID = 'openai-community/gpt2'
MODEL_FILE = 'gpt2-explainer-q8.onnx'
PROMPTS = [
    'As the spaceship was approaching the',
    'Data visualization empowers users to',
    'The cat sat on the',
]
# Extra text used only to find the few hidden dimensions where ln_f output is huge
CALIBRATION = PROMPTS + [
    'Once upon a time there was a',
    'Artificial intelligence is transforming the',
    'The quick brown fox jumps over the lazy dog. Then it ran into the forest',
    '1, 2, 3, 4, 5,',
]
BLOCK_SIZE = 64      # weights per 8-bit block in MatMulNBits
OUTLIER_ROWS = 4     # embedding rows kept in fp32
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# name, shape (n = number of tokens, L = layers), description
OUTPUTS = [
    ('tok_emb', ['n', 'D'], 'Token embedding rows, wte[ids]'),
    ('pos_emb', ['n', 'D'], 'Learned position embedding rows, wpe[0..n-1]'),
    ('ln1', ['L', 'n', 'D'], 'ln_1 output, the input to attention'),
    ('q', ['L', 'n', 'D'], 'Queries from c_attn. Head h uses columns h*DH to h*DH+DH-1'),
    ('k', ['L', 'n', 'D'], 'Keys from c_attn, same layout as q'),
    ('v', ['L', 'n', 'D'], 'Values from c_attn, same layout as q'),
    ('attn', ['L', 'H', 'n', 'n'], 'Attention probabilities after the causal mask and softmax'),
    ('attn_out', ['L', 'n', 'D'], 'Attention c_proj output'),
    ('resid_mid', ['L', 'n', 'D'], 'Residual after attention: block input + attn_out'),
    ('ln2', ['L', 'n', 'D'], 'ln_2 output, the input to the MLP'),
    ('mlp_pre', ['L', 'n', 'DFF'], 'MLP c_fc output before GELU'),
    ('mlp_out', ['L', 'n', 'D'], 'MLP c_proj output'),
    ('hidden', ['L+1', 'n', 'D'], 'Residual stream: hidden[0] is the embedding, hidden[l+1] is block l output'),
    ('ln_f', ['n', 'D'], 'Final layer-norm output'),
    ('logits', ['V'], 'Next-token logits for the last position only'),
]
OUTPUT_NAMES = [o[0] for o in OUTPUTS]


class GPT2Explainer(nn.Module):
    """GPT-2 forward pass written out step by step so every activation can be returned.

    The token embedding is stored once, transposed to [D, V]. The lookup gathers
    columns from it and the output layer multiplies by it, so the tied weight
    appears only once in the ONNX file and is quantized only once.
    """

    def __init__(self, hf):
        super().__init__()
        t = hf.transformer
        cfg = hf.config
        self.D, self.H = cfg.n_embd, cfg.n_head
        self.DH = self.D // self.H
        self.wte_t = nn.Parameter(t.wte.weight.detach().t().contiguous(), requires_grad=False)
        self.wpe = nn.Parameter(t.wpe.weight.detach().clone(), requires_grad=False)
        self.blocks = t.h
        self.ln_f = t.ln_f

    def forward(self, input_ids):
        n = input_ids.shape[0]
        D, H, DH = self.D, self.H, self.DH
        pos = torch.arange(n, dtype=torch.int64, device=input_ids.device)
        tok = torch.index_select(self.wte_t, 1, input_ids).transpose(0, 1)
        pe = torch.index_select(self.wpe, 0, pos)
        x = tok + pe
        future = pos.unsqueeze(0) > pos.unsqueeze(1)  # [n, n], True above the diagonal

        def heads(t):
            return t.reshape(n, H, DH).transpose(0, 1)  # [H, n, DH]

        keep = {k: [] for k in ('ln1', 'q', 'k', 'v', 'attn', 'attn_out', 'resid_mid', 'ln2', 'mlp_pre', 'mlp_out')}
        hidden = [x]
        for blk in self.blocks:
            a = blk.ln_1(x)
            qkv = a @ blk.attn.c_attn.weight + blk.attn.c_attn.bias
            q, k, v = qkv.split(D, dim=1)
            scores = heads(q) @ heads(k).transpose(1, 2) / math.sqrt(DH)
            scores = scores.masked_fill(future, float('-inf'))
            probs = torch.softmax(scores, dim=-1)
            ctx = (probs @ heads(v)).transpose(0, 1).reshape(n, D)
            attn_out = ctx @ blk.attn.c_proj.weight + blk.attn.c_proj.bias
            mid = x + attn_out
            m = blk.ln_2(mid)
            pre = m @ blk.mlp.c_fc.weight + blk.mlp.c_fc.bias
            mlp_out = blk.mlp.act(pre) @ blk.mlp.c_proj.weight + blk.mlp.c_proj.bias
            x = mid + mlp_out
            for name, val in (('ln1', a), ('q', q), ('k', k), ('v', v), ('attn', probs), ('attn_out', attn_out),
                              ('resid_mid', mid), ('ln2', m), ('mlp_pre', pre), ('mlp_out', mlp_out)):
                keep[name].append(val)
            hidden.append(x)
        f = self.ln_f(x)
        logits = (f[-1:] @ self.wte_t).reshape(-1)
        st = {k: torch.stack(v) for k, v in keep.items()}
        return (tok, pe, st['ln1'], st['q'], st['k'], st['v'], st['attn'], st['attn_out'], st['resid_mid'],
                st['ln2'], st['mlp_pre'], st['mlp_out'], torch.stack(hidden), f, logits)


def log(msg):
    print(msg, flush=True)


def max_abs(a, b):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    return float(np.max(np.abs(a - b))) if a.size else 0.0


def top5(logits):
    return [int(i) for i in np.argsort(-np.asarray(logits))[:5]]


def check_against_hf(hf, wrapper, tok):
    """The step-by-step module must reproduce Hugging Face GPT-2 exactly (fp32)."""
    rows = []
    for p in PROMPTS:
        ids = torch.tensor(tok.encode(p), dtype=torch.int64)
        with torch.no_grad():
            ref = hf(ids[None], output_hidden_states=True, output_attentions=True)
            out = dict(zip(OUTPUT_NAMES, wrapper(ids)))
        L = len(ref.attentions)
        # Hugging Face applies ln_f to its last hidden state, so compare blocks 0..L-2 directly
        d_hidden = max(max_abs(ref.hidden_states[i][0], out['hidden'][i]) for i in range(L))
        d_lnf = max_abs(ref.hidden_states[L][0], out['ln_f'])
        d_attn = max(max_abs(ref.attentions[i][0], out['attn'][i]) for i in range(L))
        d_logits = max_abs(ref.logits[0, -1], out['logits'])
        rows.append({'prompt': p, 'tokens': int(ids.numel()), 'logits': d_logits, 'hidden': d_hidden,
                     'ln_f': d_lnf, 'attn': d_attn,
                     'top5_match': top5(ref.logits[0, -1].numpy()) == top5(out['logits'].numpy())})
        log(f'  wrapper vs HF  {p!r}: logits {d_logits:.2e}  hidden {d_hidden:.2e}  ln_f {d_lnf:.2e}  attn {d_attn:.2e}')
    return rows


def export(wrapper, path, tok):
    ids = torch.tensor(tok.encode(PROMPTS[0]), dtype=torch.int64)
    seq = torch.export.Dim('seq', min=1, max=1024)
    t0 = time.time()
    try:
        prog = torch.onnx.export(wrapper, (ids,), dynamo=True, input_names=['input_ids'], output_names=OUTPUT_NAMES,
                                 dynamic_shapes=({0: seq},), opset_version=18, external_data=False)
        prog.save(path, external_data=False)
        how = 'torch.onnx.export (dynamo)'
    except Exception as e:  # older or newer torch versions without the dynamo path
        log(f'  dynamo export failed ({type(e).__name__}: {e}); falling back to the TorchScript exporter')
        torch.onnx.export(wrapper, (ids,), path, dynamo=False, input_names=['input_ids'], output_names=OUTPUT_NAMES,
                          dynamic_axes={'input_ids': {0: 'n'}}, opset_version=17)
        how = 'torch.onnx.export (TorchScript)'
    log(f'  exported fp32 model with {how} in {time.time() - t0:.0f}s: {os.path.getsize(path) / 1e6:.0f} MB')
    return how


def outlier_dims(fp32_path, tok):
    """Hidden dimensions where the final layer norm output is largest (GPT-2 has a few, up to about 200)."""
    s = session(fp32_path)
    f = np.concatenate([s.run(['ln_f'], {'input_ids': np.array(tok.encode(p), dtype=np.int64)})[0] for p in CALIBRATION])
    mean = np.abs(f).mean(0)
    dims = [int(d) for d in np.argsort(-mean)[:OUTLIER_ROWS]]
    log(f'  ln_f outlier dims {dims}: mean |value| {[round(float(mean[d]), 1) for d in dims]}, median {np.median(mean):.2f}')
    return dims


def quantize_embedding(m, dims, name='wte_t'):
    """Store the tied [D, V] embedding as int8 with one scale per hidden dimension.

    The rows for the outlier dimensions stay fp32: the output layer multiplies them by
    values near 200, so 8-bit error there would move the logits by about 1. The page
    reads the fp32 matrix rebuilt from these parts; onnxruntime folds it once at load.
    """
    init = next(i for i in m.graph.initializer if i.name == name)
    w = numpy_helper.to_array(init).astype(np.float32)
    keep = np.array(dims, dtype=np.int64)
    scale = (np.abs(w).max(axis=1, keepdims=True) / 127.0).astype(np.float32)
    q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
    q[keep] = 0
    place = np.zeros((w.shape[0], len(keep)), np.float32)
    place[keep, np.arange(len(keep))] = 1
    m.graph.initializer.remove(init)
    m.graph.initializer.extend([numpy_helper.from_array(q, name + '_q'), numpy_helper.from_array(scale, name + '_scale'),
                                numpy_helper.from_array(w[keep], name + '_rows'),
                                numpy_helper.from_array(place, name + '_place')])
    nodes = [helper.make_node('Cast', [name + '_q'], [name + '_f'], to=TensorProto.FLOAT, name=name + '_cast'),
             helper.make_node('Mul', [name + '_f', name + '_scale'], [name + '_main'], name=name + '_dequant'),
             helper.make_node('MatMul', [name + '_place', name + '_rows'], [name + '_extra'], name=name + '_place_rows'),
             helper.make_node('Add', [name + '_main', name + '_extra'], [name], name=name + '_sum')]
    for i, n in enumerate(nodes):
        m.graph.node.insert(i, n)
    return [n.name for n in nodes]


def quantize(fp32_path, q_path, tok):
    """8-bit weights. The 48 block MatMuls use MatMulNBits (weight-only, fp32 maths)."""
    dims = outlier_dims(fp32_path, tok)
    m = onnx.load(fp32_path)
    skip = quantize_embedding(m, dims)
    # the output layer reads the rebuilt embedding, so it is not quantized again
    skip += [n.name for n in m.graph.node if n.op_type == 'MatMul' and 'wte_t' in n.input]
    q = MatMulNBitsQuantizer(m, bits=8, block_size=BLOCK_SIZE, is_symmetric=True, nodes_to_exclude=skip)
    q.process()
    q.model.save_model_to_file(q_path, use_external_data_format=False)
    out = onnx.load(q_path)
    n_q = sum(1 for n in out.graph.node if n.op_type == 'MatMulNBits')
    big = sorted(((int(np.prod(i.dims)), i.name, i.data_type) for i in out.graph.initializer), reverse=True)[:3]
    log(f'  quantized: {os.path.getsize(q_path) / 1e6:.1f} MB, {n_q} MatMulNBits nodes; largest tensors: '
        + ', '.join(f'{name} {n / 1e6:.1f}M ({TensorProto.DataType.Name(dt)})' for n, name, dt in big))
    return dims


def session(path):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])


def check_onnx(wrapper, fp32_path, q_path, tok):
    s32, s8 = session(fp32_path), session(q_path)
    rows = []
    for p in PROMPTS + ['Hi']:  # 'Hi' is one token: checks the dynamic axis at its minimum
        ids = np.array(tok.encode(p), dtype=np.int64)
        with torch.no_grad():
            ref = {k: v.numpy() for k, v in zip(OUTPUT_NAMES, wrapper(torch.from_numpy(ids)))}
        o32 = dict(zip(OUTPUT_NAMES, s32.run(OUTPUT_NAMES, {'input_ids': ids})))
        o8 = dict(zip(OUTPUT_NAMES, s8.run(OUTPUT_NAMES, {'input_ids': ids})))
        d32 = {k: max_abs(ref[k], o32[k]) for k in OUTPUT_NAMES}
        d8 = {k: max_abs(o32[k], o8[k]) for k in OUTPUT_NAMES}
        r8 = {k: d8[k] / max(1e-9, float(np.max(np.abs(o32[k])))) for k in OUTPUT_NAMES}
        # Recompute the attention softmax from q and k the way the page does
        L, H = o8['attn'].shape[:2]
        n, D = ids.size, o8['q'].shape[2]
        DH = D // H
        qh = o8['q'].reshape(L, n, H, DH).transpose(0, 2, 1, 3)
        kh = o8['k'].reshape(L, n, H, DH).transpose(0, 2, 1, 3)
        s = qh @ kh.transpose(0, 1, 3, 2) / math.sqrt(DH)
        s = np.where(np.triu(np.ones((n, n), bool), 1), -np.inf, s)
        e = np.exp(s - s.max(-1, keepdims=True))
        d_soft = max_abs(e / e.sum(-1, keepdims=True), o8['attn'])
        t_ref, t32, t8 = top5(ref['logits']), top5(o32['logits']), top5(o8['logits'])
        rows.append({
            'prompt': p, 'tokens': int(n),
            'fp32_vs_torch_max_abs': d32, 'q8_vs_fp32_max_abs': d8,
            'q8_vs_fp32_relative_to_largest_value': r8, 'q8_softmax_recompute_max_abs': d_soft,
            'top5_fp32': [tok.decode([i]) for i in t32], 'top5_q8': [tok.decode([i]) for i in t8],
            'top5_fp32_logits': [round(float(o32['logits'][i]), 3) for i in t32],
            'top5_same_tokens': set(t_ref) == set(t32) == set(t8),
            'top5_same_order': t_ref == t32 == t8,
        })
        log(f'  {p!r} ({n} tokens)')
        log(f'    fp32 ONNX vs torch: logits {d32["logits"]:.2e}, worst {max(d32.values()):.2e}')
        log(f'    q8 vs fp32: logits {d8["logits"]:.3f}, attn {d8["attn"]:.3f}, hidden {d8["hidden"]:.3f} '
            f'({100 * r8["hidden"]:.2f}% of its largest value), mlp_pre {d8["mlp_pre"]:.3f}; '
            f'softmax recompute {d_soft:.1e}')
        log(f'    top-5 fp32 {rows[-1]["top5_fp32"]} {rows[-1]["top5_fp32_logits"]}')
        log(f'    top-5 q8   {rows[-1]["top5_q8"]}  same tokens={rows[-1]["top5_same_tokens"]}, '
            f'same order={rows[-1]["top5_same_order"]}')
    return rows


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=os.path.join(ROOT, 'models', 'gpt2-explainer'), help='output folder')
    ap.add_argument('--work', default=None, help='folder for the fp32 intermediate (default: a temporary folder)')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    work = args.work or tempfile.mkdtemp(prefix='gpt2x-')
    os.makedirs(work, exist_ok=True)
    fp32_path = os.path.join(work, 'gpt2-explainer-fp32.onnx')
    q_path = os.path.join(args.out, MODEL_FILE)
    torch.manual_seed(0)

    log(f'1/5 loading {MODEL_ID}')
    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    hf = GPT2LMHeadModel.from_pretrained(MODEL_ID, attn_implementation='eager').eval()
    cfg = hf.config
    wrapper = GPT2Explainer(hf).eval()

    log('2/5 checking the step-by-step module against Hugging Face')
    hf_rows = check_against_hf(hf, wrapper, tok)

    log('3/5 exporting to ONNX')
    how = export(wrapper, fp32_path, tok)

    log('4/5 quantizing weights to 8 bits')
    outliers = quantize(fp32_path, q_path, tok)

    log('5/5 validating fp32 and 8-bit models')
    rows = check_onnx(wrapper, fp32_path, q_path, tok)
    ok = all(r['top5_same_tokens'] for r in rows) and all(r['top5_match'] for r in hf_rows)

    dims = {'D': cfg.n_embd, 'H': cfg.n_head, 'DH': cfg.n_embd // cfg.n_head, 'DFF': 4 * cfg.n_embd,
            'L': cfg.n_layer, 'V': cfg.vocab_size, 'maxPositions': cfg.n_positions}
    size = {'n': 'n', 'D': dims['D'], 'DFF': dims['DFF'], 'L': dims['L'], 'L+1': dims['L'] + 1, 'H': dims['H'],
            'V': dims['V']}
    worst = lambda key: max(max(r[key].values()) for r in rows)
    manifest = {
        'name': 'gpt2-explainer',
        'description': 'GPT-2 small (124M) with its internal activations exposed as outputs, for transformer.html',
        'source': MODEL_ID,
        'file': MODEL_FILE,
        'bytes': os.path.getsize(q_path),
        'sha256': sha256(q_path),
        'created': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'exporter': {'method': how, 'torch': torch.__version__, 'onnx': onnx.__version__,
                     'onnxruntime': ort.__version__,
                     'opset': next(o.version for o in onnx.load(q_path).opset_import if o.domain in ('', 'ai.onnx'))},
        'quantization': {
            'method': f'onnxruntime MatMulNBitsQuantizer, 8-bit symmetric, block size {BLOCK_SIZE}',
            'blocks': 'The 48 block weight matrices are stored as 8-bit MatMulNBits; the maths runs in fp32.',
            'embedding': 'The tied token embedding is stored once as int8 with one scale per hidden dimension. '
                         f'Rows {outliers} stay fp32 because ln_f output is very large there. It is rebuilt '
                         'as fp32 when the session loads and is shared by the lookup and the output layer.',
            'fp32': 'Position table, biases, layer norms, attention scores, softmax and GELU.',
        },
        'dims': dims,
        'embeddingFp32Rows': outliers,
        'inputs': [{'name': 'input_ids', 'type': 'int64', 'shape': ['n'],
                    'description': 'GPT-2 token ids for one sequence, 1 to 1024 tokens, no batch axis'}],
        'outputs': [{'name': nm, 'type': 'float32', 'shape': [size[s] for s in shp], 'description': desc}
                    for nm, shp, desc in OUTPUTS],
        'notes': [
            'q, k and v keep heads merged: head h of layer l is q[l][:, h*DH:(h+1)*DH].',
            'Raw scores (q.k), scaling by sqrt(DH), the mask and head outputs (attn x v) are recomputed in the page.',
            'GELU uses the tanh approximation (gelu_new), as GPT-2 does.',
        ],
        'validation': {
            'prompts': PROMPTS,
            'wrapper_vs_huggingface': hf_rows,
            'onnx': rows,
            'summary': {
                'fp32_vs_torch_worst_max_abs': worst('fp32_vs_torch_max_abs'),
                'q8_vs_fp32_logits_max_abs': max(r['q8_vs_fp32_max_abs']['logits'] for r in rows),
                'q8_vs_fp32_attn_max_abs': max(r['q8_vs_fp32_max_abs']['attn'] for r in rows),
                'q8_vs_fp32_worst_relative': max(max(r['q8_vs_fp32_relative_to_largest_value'].values()) for r in rows),
                'q8_softmax_recompute_max_abs': max(r['q8_softmax_recompute_max_abs'] for r in rows),
                'top5_same_tokens_all': ok,
                'top5_same_order_all': all(r['top5_same_order'] for r in rows),
            },
        },
    }
    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    log(f'done: {q_path} ({manifest["bytes"] / 1e6:.1f} MB), manifest.json written; top-5 tokens match: {ok}')
    if not ok:
        log('WARNING: the top-5 next tokens differ between the reference and the 8-bit model')
        sys.exit(1)


if __name__ == '__main__':
    main()
