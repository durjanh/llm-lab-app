/* Training lab: a tiny character-level language model, trained live in the browser.
 * The model is a Bengio-style MLP: k previous characters -> embeddings -> tanh hidden layer -> softmax.
 * Everything below the UI line also runs in Node, where the gradient check lives. */
(function () {
  'use strict';

  // ---------- the model ----------
  const TinyLM = (function () {
    function gauss(rng) {
      let u = 0;
      while (u === 0) u = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    }
    // All weights live in one flat array; these are the offsets of each block.
    function layout(V, k, d, H) {
      const L = {}; let n = 0;
      L.C = n; n += V * d;          // character embeddings, V x d
      L.W1 = n; n += k * d * H;     // hidden weights, (k*d) x H
      L.b1 = n; n += H;
      L.W2 = n; n += H * V;         // output weights, H x V
      L.b2 = n; n += V;
      L.n = n;
      return L;
    }
    function create(cfg, rng, F = Float32Array) {
      const { V, k, d, H } = cfg, L = layout(V, k, d, H), p = new F(L.n);
      for (let i = 0; i < V * d; i++) p[L.C + i] = gauss(rng);
      const s1 = 1 / Math.sqrt(k * d);
      for (let i = 0; i < k * d * H; i++) p[L.W1 + i] = gauss(rng) * s1;
      for (let i = 0; i < H; i++) p[L.b1 + i] = gauss(rng) * 0.01;
      // Small output weights make the first prediction close to uniform, so the
      // starting loss is close to ln V.
      for (let i = 0; i < H * V; i++) p[L.W2 + i] = gauss(rng) * 0.01;
      return {
        V, k, d, H, L, p, t: 0,
        g: new F(L.n), m: new F(L.n), v: new F(L.n),
        emb: new F(k * d), demb: new F(k * d), h: new F(H), dh: new F(H), z: new F(V)
      };
    }
    // Forward pass for one context. Leaves embeddings in M.emb, hidden values in M.h,
    // logits in M.z.
    function forward(M, X, base) {
      const { V, k, d, H, L, p, emb, h, z } = M, kd = k * d;
      for (let t = 0; t < k; t++) {
        const c = L.C + X[base + t] * d, o = t * d;
        for (let e = 0; e < d; e++) emb[o + e] = p[c + e];
      }
      for (let j = 0; j < H; j++) h[j] = p[L.b1 + j];
      for (let i = 0; i < kd; i++) {
        const a = emb[i], w = L.W1 + i * H;
        for (let j = 0; j < H; j++) h[j] += a * p[w + j];
      }
      for (let j = 0; j < H; j++) h[j] = Math.tanh(h[j]);
      for (let v = 0; v < V; v++) z[v] = p[L.b2 + v];
      for (let j = 0; j < H; j++) {
        const a = h[j], w = L.W2 + j * V;
        for (let v = 0; v < V; v++) z[v] += a * p[w + v];
      }
    }
    // Turns M.z into probabilities in place and returns -ln p(target).
    function softmaxLoss(M, y) {
      const { V, z } = M;
      let mx = -Infinity;
      for (let v = 0; v < V; v++) if (z[v] > mx) mx = z[v];
      const zy = z[y];
      let s = 0;
      for (let v = 0; v < V; v++) { z[v] = Math.exp(z[v] - mx); s += z[v]; }
      for (let v = 0; v < V; v++) z[v] /= s;
      return Math.log(s) + mx - zy;
    }
    // Mean cross-entropy over a batch, with gradients written to M.g.
    function lossAndGrad(M, X, Y, idx, B) {
      M.g.fill(0);
      return accumulate(M, X, Y, idx, 0, B, B) / B;
    }
    // Adds the gradients of examples idx[from..to) of a batch of size B into M.g and
    // returns their summed loss. Lets the page split one batch across time slices.
    function accumulate(M, X, Y, idx, from, to, B) {
      const { V, k, d, H, L, p, g, emb, demb, h, dh, z } = M, kd = k * d;
      let loss = 0;
      for (let b = from; b < to; b++) {
        const ex = idx[b], base = ex * k, y = Y[ex];
        forward(M, X, base);
        loss += softmaxLoss(M, y);
        // d loss / d logits = (probabilities - one-hot target) / B
        for (let v = 0; v < V; v++) z[v] /= B;
        z[y] -= 1 / B;
        for (let v = 0; v < V; v++) g[L.b2 + v] += z[v];
        for (let j = 0; j < H; j++) {
          const a = h[j], w = L.W2 + j * V;
          let acc = 0;
          for (let v = 0; v < V; v++) { acc += p[w + v] * z[v]; g[w + v] += a * z[v]; }
          dh[j] = acc * (1 - a * a);                  // back through tanh
        }
        for (let j = 0; j < H; j++) g[L.b1 + j] += dh[j];
        for (let i = 0; i < kd; i++) {
          const a = emb[i], w = L.W1 + i * H;
          let acc = 0;
          for (let j = 0; j < H; j++) { acc += p[w + j] * dh[j]; g[w + j] += a * dh[j]; }
          demb[i] = acc;
        }
        for (let t = 0; t < k; t++) {
          const c = L.C + X[base + t] * d, o = t * d;
          for (let e = 0; e < d; e++) g[c + e] += demb[o + e];
        }
      }
      return loss;
    }
    // Summed loss over examples idx[from..to), forward only.
    function lossSum(M, X, Y, idx, from, to) {
      let s = 0;
      for (let i = from; i < to; i++) { const ex = idx[i]; forward(M, X, ex * M.k); s += softmaxLoss(M, Y[ex]); }
      return s;
    }
    function adam(M, lr, b1 = 0.9, b2 = 0.999, eps = 1e-8) {
      M.t++;
      const { p, g, m, v } = M, a = lr * Math.sqrt(1 - Math.pow(b2, M.t)) / (1 - Math.pow(b1, M.t));
      for (let i = 0; i < p.length; i++) {
        const gi = g[i];
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        p[i] -= a * m[i] / (Math.sqrt(v[i]) + eps);
      }
    }
    // Generates n characters after the context ctx, an Int32Array of length k that
    // slides forward as it goes, so a long sample can be made in several calls.
    function generate(M, ctx, n, temperature, rng) {
      const k = M.k, out = [];
      for (let s = 0; s < n; s++) {
        forward(M, ctx, 0);
        const { V, z } = M, T = Math.max(0.05, temperature);
        let mx = -Infinity;
        for (let v = 0; v < V; v++) { z[v] /= T; if (z[v] > mx) mx = z[v]; }
        let sum = 0;
        for (let v = 0; v < V; v++) { z[v] = Math.exp(z[v] - mx); sum += z[v]; }
        let r = rng() * sum, pick = V - 1;
        for (let v = 0; v < V; v++) { r -= z[v]; if (r <= 0) { pick = v; break; } }
        out.push(pick);
        ctx.copyWithin(0, 1); ctx[k - 1] = pick;
      }
      return out;
    }
    // Every (context, next character) pair in a sequence of ids.
    function examples(ids, k) {
      const n = Math.max(0, ids.length - k), X = new Int32Array(n * k), Y = new Int32Array(n);
      for (let i = 0; i < n; i++) { for (let t = 0; t < k; t++) X[i * k + t] = ids[i + t]; Y[i] = ids[i + k]; }
      return { X, Y, n };
    }
    // Compares backpropagation with central finite differences, in double precision.
    function gradCheck(opts = {}) {
      const { V = 7, k = 3, d = 4, H = 6, B = 5, eps = 1e-5, seed = 1 } = opts;
      const rng = (function (a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })(seed);
      const M = create({ V, k, d, H }, rng, Float64Array);
      for (let i = 0; i < M.p.length; i++) M.p[i] += 0.3 * gauss(rng);   // move away from the near-uniform start
      const ids = Array.from({ length: B + k + 3 }, () => Math.floor(rng() * V));
      const { X, Y } = examples(ids, k), idx = Int32Array.from({ length: B }, (_, i) => i);
      lossAndGrad(M, X, Y, idx, B);
      const analytic = Float64Array.from(M.g);
      let maxRel = 0, worst = -1;
      for (let i = 0; i < M.p.length; i++) {
        const old = M.p[i];
        M.p[i] = old + eps; const lp = lossSum(M, X, Y, idx, 0, B) / B;
        M.p[i] = old - eps; const lm = lossSum(M, X, Y, idx, 0, B) / B;
        M.p[i] = old;
        const num = (lp - lm) / (2 * eps), a = analytic[i];
        const rel = Math.abs(num - a) / Math.max(1e-8, Math.abs(num) + Math.abs(a));
        if (rel > maxRel) { maxRel = rel; worst = i; }
      }
      return { params: M.p.length, maxRelError: maxRel, worstIndex: worst, ok: maxRel < 1e-5 };
    }
    return { layout, create, forward, softmaxLoss, lossAndGrad, accumulate, lossSum, adam, generate, examples, gradCheck };
  })();

  // ---------- datasets ----------
  const DATA = {};
  DATA.austen = `It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.

However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful property of some one or other of their daughters.

"My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?"

Mr. Bennet replied that he had not.

"But it is," returned she; "for Mrs. Long has just been here, and she told me all about it."

Mr. Bennet made no answer.

"Do not you want to know who has taken it?" cried his wife, impatiently.

"You want to tell me, and I have no objection to hearing it."

This was invitation enough.

"Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week."

"What is his name?"

"Bingley."

"Is he married or single?"

"Oh, single, my dear, to be sure! A single man of large fortune; four or five thousand a year. What a fine thing for our girls!"

"How so? how can it affect them?"

"My dear Mr. Bennet," replied his wife, "how can you be so tiresome? You must know that I am thinking of his marrying one of them."

"Is that his design in settling here?"

"Design? Nonsense, how can you talk so! But it is very likely that he may fall in love with one of them, and therefore you must visit him as soon as he comes."

"I see no occasion for that. You and the girls may go--or you may send them by themselves, which perhaps will be still better; for as you are as handsome as any of them, Mr. Bingley might like you the best of the party."

"My dear, you flatter me. I certainly have had my share of beauty, but I do not pretend to be anything extraordinary now. When a woman has five grown-up daughters, she ought to give over thinking of her own beauty."

"In such cases, a woman has not often much beauty to think of."

"But, my dear, you must indeed go and see Mr. Bingley when he comes into the neighbourhood."

"It is more than I engage for, I assure you."

"But consider your daughters. Only think what an establishment it would be for one of them. Sir William and Lady Lucas are determined to go, merely on that account; for in general, you know, they visit no new comers. Indeed you must go, for it will be impossible for us to visit him, if you do not."

"You are over scrupulous, surely. I dare say Mr. Bingley will be very glad to see you; and I will send a few lines by you to assure him of my hearty consent to his marrying whichever he chooses of the girls--though I must throw in a good word for my little Lizzy."

"I desire you will do no such thing. Lizzy is not a bit better than the others: and I am sure she is not half so handsome as Jane, nor half so good-humoured as Lydia. But you are always giving her the preference."

"They have none of them much to recommend them," replied he: "they are all silly and ignorant like other girls; but Lizzy has something more of quickness than her sisters."

"Mr. Bennet, how can you abuse your own children in such a way? You take delight in vexing me. You have no compassion on my poor nerves."

"You mistake me, my dear. I have a high respect for your nerves. They are my old friends. I have heard you mention them with consideration these twenty years at least."

"Ah, you do not know what I suffer."

"But I hope you will get over it, and live to see many young men of four thousand a year come into the neighbourhood."

"It will be no use to us, if twenty such should come, since you will not visit them."

"Depend upon it, my dear, that when there are twenty, I will visit them all."

Mr. Bennet was so odd a mixture of quick parts, sarcastic humour, reserve, and caprice, that the experience of three-and-twenty years had been insufficient to make his wife understand his character. Her mind was less difficult to develope. She was a woman of mean understanding, little information, and uncertain temper. When she was discontented, she fancied herself nervous. The business of her life was to get her daughters married: its solace was visiting and news.

Mr. Bennet was among the earliest of those who waited on Mr. Bingley. He had always intended to visit him, though to the last always assuring his wife that he should not go; and till the evening after the visit was paid she had no knowledge of it. It was then disclosed in the following manner. Observing his second daughter employed in trimming a hat, he suddenly addressed her with,--

"I hope Mr. Bingley will like it, Lizzy."

"We are not in a way to know what Mr. Bingley likes," said her mother, resentfully, "since we are not to visit."

"But you forget, mamma," said Elizabeth, "that we shall meet him at the assemblies, and that Mrs. Long has promised to introduce him."

"I do not believe Mrs. Long will do any such thing. She has two nieces of her own. She is a selfish, hypocritical woman, and I have no opinion of her."

"No more have I," said Mr. Bennet; "and I am glad to find that you do not depend on her serving you."

Mrs. Bennet deigned not to make any reply; but, unable to contain herself, began scolding one of her daughters.

"Don't keep coughing so, Kitty, for heaven's sake! Have a little compassion on my nerves. You tear them to pieces."

"Kitty has no discretion in her coughs," said her father; "she times them ill."

"I do not cough for my own amusement," replied Kitty, fretfully. "When is your next ball to be, Lizzy?"

"To-morrow fortnight."

"Ay, so it is," cried her mother, "and Mrs. Long does not come back till the day before; so, it will be impossible for her to introduce him, for she will not know him herself."

"Then, my dear, you may have the advantage of your friend, and introduce Mr. Bingley to her."

"Impossible, Mr. Bennet, impossible, when I am not acquainted with him myself; how can you be so teasing?"

"I honour your circumspection. A fortnight's acquaintance is certainly very little. One cannot know what a man really is by the end of a fortnight. But if we do not venture, somebody else will; and after all, Mrs. Long and her nieces must stand their chance; and, therefore, as she will think it an act of kindness, if you decline the office, I will take it on myself."

The girls stared at their father. Mrs. Bennet said only, "Nonsense, nonsense!"

"What can be the meaning of that emphatic exclamation?" cried he. "Do you consider the forms of introduction, and the stress that is laid on them, as nonsense? I cannot quite agree with you there. What say you, Mary? For you are a young lady of deep reflection, I know, and read great books, and make extracts."

Mary wished to say something very sensible, but knew not how.

"While Mary is adjusting her ideas," he continued, "let us return to Mr. Bingley."

"I am sick of Mr. Bingley," cried his wife.

"I am sorry to hear that; but why did you not tell me so before? If I had known as much this morning, I certainly would not have called on him. It is very unlucky; but as I have actually paid the visit, we cannot escape the acquaintance now."

The astonishment of the ladies was just what he wished--that of Mrs. Bennet perhaps surpassing the rest; though when the first tumult of joy was over, she began to declare that it was what she had expected all the while.

"How good it was in you, my dear Mr. Bennet! But I knew I should persuade you at last. I was sure you loved your girls too well to neglect such an acquaintance. Well, how pleased I am! And it is such a good joke, too, that you should have gone this morning, and never said a word about it till now."

"Now, Kitty, you may cough as much as you choose," said Mr. Bennet; and, as he spoke, he left the room, fatigued with the raptures of his wife.

"What an excellent father you have, girls," said she, when the door was shut. "I do not know how you will ever make him amends for his kindness; or me either, for that matter. At our time of life, it is not so pleasant, I can tell you, to be making new acquaintances every day; but for your sakes we would do anything. Lydia, my love, though you are the youngest, I dare say Mr. Bingley will dance with you at the next ball."

"Oh," said Lydia, stoutly, "I am not afraid; for though I am the youngest, I'm the tallest."

The rest of the evening was spent in conjecturing how soon he would return Mr. Bennet's visit, and determining when they should ask him to dinner.`;

  DATA.faq = `Q: How do I reset my password?
A: Open Settings, choose Security, then select Reset password. We will email you a link.

Q: How do I change my email address?
A: Open Settings, choose Profile, then select Change email. We will email you a link to confirm it.

Q: How do I cancel my subscription?
A: Open Settings, choose Billing, then select Cancel plan. Your plan stays active until the end of the month.

Q: How do I update my card details?
A: Open Settings, choose Billing, then select Update card. The new card is used from your next bill.

Q: How do I download my invoices?
A: Open Settings, choose Billing, then select Invoices. Each invoice can be saved as a PDF.

Q: How do I add a team member?
A: Open Settings, choose Team, then select Invite. We will email them a link to join.

Q: How do I remove a team member?
A: Open Settings, choose Team, then select Remove next to their name. Their files stay in the team folder.

Q: How do I turn on two-step login?
A: Open Settings, choose Security, then select Two-step login. You will need your phone to finish.

Q: How do I change my display name?
A: Open Settings, choose Profile, then select Edit name. The change shows up straight away.

Q: How do I delete my account?
A: Open Settings, choose Profile, then select Delete account. We keep your data for 30 days in case you change your mind.

Q: How do I export my data?
A: Open Settings, choose Privacy, then select Export data. We will email you a link when the file is ready.

Q: How do I change the language?
A: Open Settings, choose Profile, then select Language. The app reloads in the new language.

Q: How do I stop email notifications?
A: Open Settings, choose Notifications, then turn off Email. You will still get messages about billing.

Q: How do I upgrade my plan?
A: Open Settings, choose Billing, then select Change plan. You only pay the difference for this month.

Q: How do I contact support?
A: Open Help, then select Contact us. We reply within one working day.

Q: How do I change my time zone?
A: Open Settings, choose Profile, then select Time zone. Reminders use the new time zone from now on.

Q: How do I share a file?
A: Open the file, then select Share. You can choose who can view it and who can edit it.

Q: How do I restore a deleted file?
A: Open Files, choose Bin, then select Restore. Files stay in the bin for 30 days.

Q: How do I log out of all devices?
A: Open Settings, choose Security, then select Log out everywhere. You will need to log in again on each device.

Q: How do I change my phone number?
A: Open Settings, choose Security, then select Change phone. We will text you a code to confirm it.

Q: How do I see my usage?
A: Open Settings, choose Billing, then select Usage. The chart shows this month and last month.

Q: How do I rename a team?
A: Open Settings, choose Team, then select Rename. Everyone in the team sees the new name.
`;

  DATA.code = `def mean(values):
    if not values:
        return 0.0
    return sum(values) / len(values)


def median(values):
    ordered = sorted(values)
    n = len(ordered)
    if n == 0:
        return 0.0
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def clamp(value, low, high):
    if value < low:
        return low
    if value > high:
        return high
    return value


def chunks(items, size):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def flatten(nested):
    result = []
    for item in nested:
        if isinstance(item, list):
            result.extend(flatten(item))
        else:
            result.append(item)
    return result


def word_count(text):
    counts = {}
    for word in text.lower().split():
        counts[word] = counts.get(word, 0) + 1
    return counts


def is_palindrome(text):
    letters = [c.lower() for c in text if c.isalnum()]
    return letters == letters[::-1]


def factorial(n):
    result = 1
    for i in range(2, n + 1):
        result *= i
    return result


def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


def unique(items):
    seen = set()
    result = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def binary_search(items, target):
    low, high = 0, len(items) - 1
    while low <= high:
        mid = (low + high) // 2
        if items[mid] == target:
            return mid
        if items[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1


def merge(left, right):
    result = []
    i, j = 0, 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    result.extend(left[i:])
    result.extend(right[j:])
    return result


def merge_sort(items):
    if len(items) <= 1:
        return items
    mid = len(items) // 2
    return merge(merge_sort(items[:mid]), merge_sort(items[mid:]))


def read_lines(path):
    with open(path) as f:
        return [line.strip() for line in f if line.strip()]


def parse_pair(line):
    key, value = line.split("=", 1)
    return key.strip(), value.strip()


def load_config(path):
    config = {}
    for line in read_lines(path):
        if line.startswith("#"):
            continue
        key, value = parse_pair(line)
        config[key] = value
    return config
`;

  if (typeof document === 'undefined') { module.exports = { TinyLM, DATA }; return; }
  window.TinyLM = TinyLM;   // try TinyLM.gradCheck() in the console

  // ---------- UI ----------
  const { $, $$, esc, fmtInt, mulberry32 } = Site;
  const SLICE = 12;              // ms of work per slice, so the page stays responsive
  const CHUNK = 16;              // examples per unit of work
  const SAMPLE_LEN = 200, WIN = 20, EVAL_TRAIN = 400, EVAL_VAL = 600, MIN_CHARS = 200, MAX_CHARS = 50000;
  const SCENARIOS = {
    healthy: { preset: 'austen', n: 0, k: 5, d: 10, H: 96, lr: -2.5, B: 32, steps: 3000 },
    overfit: { preset: 'austen', n: 1500, k: 8, d: 16, H: 192, lr: -2.3, B: 32, steps: 1500 }
  };
  const S = {
    preset: 'austen', own: '', nAll: true, D: null, M: null, note: '',
    step: 0, target: 0, runStart: 0, running: false, seen: 0, batch: null, lr: 0.003, B: 32,
    evals: [], samples: [], queue: [], best: null, verdict: 'idle', rate: 0, rateT: 0, rateSteps: 0
  };
  const val = id => +$('#' + id).value;
  const lrText = x => Math.pow(10, x).toPrecision(2);
  const pctOf = loss => {
    const p = Math.exp(-loss) * 100;
    return (p < 10 ? p.toFixed(1) : p.toFixed(0)) + '%';
  };

  // ---------- data ----------
  function buildData() {
    const full = Array.from($('#text').value).slice(0, MAX_CHARS), sl = $('#nChars');
    sl.max = Math.max(MIN_CHARS, full.length);
    if (S.nAll || +sl.value > full.length) sl.value = sl.max;
    const n = Math.min(full.length, +sl.value), text = full.slice(0, n), k = val('k');
    $('#vN').textContent = n >= full.length ? `all ${fmtInt(full.length)}` : `first ${fmtInt(n)} of ${fmtInt(full.length)}`;
    if (n < MIN_CHARS) return { ok: false, n, msg: `Add more text. The lab needs at least ${MIN_CHARS} characters, and this has ${fmtInt(n)}.` };
    const chars = [...new Set(text)].sort(), idOf = new Map(chars.map((c, i) => [c, i])), ids = text.map(c => idOf.get(c));
    const nVal = Math.max(Math.round(n * 0.1), k + 20);
    const trainIds = ids.slice(0, n - nVal), valIds = ids.slice(n - nVal);
    const T = TinyLM.examples(trainIds, k), Vd = TinyLM.examples(valIds, k);
    const spread = (total, m) => Int32Array.from({ length: Math.min(total, m) }, (_, i) => (total <= m ? i : Math.floor(i * total / m)));
    const trainChars = trainIds.map(i => chars[i]), windows = new Set();
    for (let i = 0; i + WIN <= trainChars.length; i++) windows.add(trainChars.slice(i, i + WIN).join(''));
    return {
      ok: true, n, chars, V: chars.length, T, Vd, windows, trainLen: trainIds.length, valLen: valIds.length,
      evTr: spread(T.n, EVAL_TRAIN), evVa: spread(Vd.n, EVAL_VAL), seedIds: trainIds.slice(0, k)
    };
  }
  function showData() {
    const D = S.D;
    $('#dataInfo').innerHTML = D.ok
      ? `<b>${fmtInt(D.n)}</b> characters, <b>${D.V}</b> of them different. <b>${fmtInt(D.trainLen)}</b> for training and <b>${fmtInt(D.valLen)}</b> held out for validation.`
      : `<span class="err">${esc(D.msg)}</span>`;
  }
  function showParams() {
    const D = S.D;
    if (!D.ok) { $('#pTotal').textContent = '–'; $('#pBreak').innerHTML = ''; $('#pRatio').textContent = '–'; $('#pHint').textContent = ''; return; }
    const V = D.V, k = val('k'), d = val('d'), H = val('H');
    const emb = V * d, hid = k * d * H + H, out = H * V + V, tot = emb + hid + out, ratio = tot / D.T.n;
    $('#pTotal').textContent = fmtInt(tot);
    $('#pBreak').innerHTML = `<div>Embeddings: ${V} characters × ${d} numbers = <b>${fmtInt(emb)}</b></div>
      <div>Hidden layer: ${k * d} inputs × ${H} units, plus ${H} biases = <b>${fmtInt(hid)}</b></div>
      <div>Output layer: ${H} units × ${V} characters, plus ${V} biases = <b>${fmtInt(out)}</b></div>`;
    $('#pRatio').textContent = ratio < 10 ? ratio.toFixed(1) : fmtInt(ratio);
    $('#pHint').textContent = ratio > 5 ? 'Far more weights than training characters. Expect the model to memorise.'
      : ratio > 1.5 ? 'More weights than training characters. Watch for memorising on long runs.'
        : 'A modest model for this much data.';
  }
  function labels() {
    $('#vk').textContent = val('k');
    $('#vd').textContent = val('d');
    $('#vH').textContent = val('H');
    $('#vlr').textContent = lrText(val('lr'));
    $('#vSteps').textContent = fmtInt(val('steps'));
    $('#vTemp').textContent = val('temp').toFixed(2);
  }

  // ---------- model lifecycle ----------
  function reset(note) {
    S.running = false;
    S.D = buildData(); showData();
    S.lr = Math.pow(10, val('lr')); S.B = val('B');
    S.step = 0; S.seen = 0; S.runStart = 0; S.target = val('steps'); S.batch = null;
    S.evals = []; S.samples = []; S.queue = []; S.best = null; S.verdict = 'idle'; S.note = note || '';
    $('#timeline').innerHTML = ''; setMeter(null); hideHover();
    showParams();
    if (!S.D.ok) { S.M = null; render(true); return; }
    const seed = Math.round(val('seed')) || 0;
    S.M = TinyLM.create({ V: S.D.V, k: val('k'), d: val('d'), H: val('H') }, mulberry32(seed));
    S.brng = mulberry32(seed + 1); S.sampleSeed = seed + 2; S.idx = new Int32Array(128);
    queueEval(); queueSample();
    kick(); render(true);
  }
  const evalEvery = () => Math.max(5, Math.round(val('steps') / 100));
  function queueEval() { S.queue.push({ type: 'eval', step: S.step, i: 0, j: 0, tr: 0, va: 0 }); }
  function queueSample() {
    S.queue.push({ type: 'sample', step: S.step, temp: val('temp'), ctx: Int32Array.from(S.D.seedIds), out: [], rng: mulberry32(S.sampleSeed) });
  }

  // One slice of a training step: part of a batch, then the Adam update once the batch is done.
  function trainChunk() {
    const M = S.M, D = S.D;
    if (!S.batch) {
      const B = S.B;
      for (let b = 0; b < B; b++) S.idx[b] = Math.floor(S.brng() * D.T.n);
      M.g.fill(0);
      S.batch = { B, pos: 0, loss: 0 };
    }
    const bt = S.batch, to = Math.min(bt.B, bt.pos + CHUNK);
    bt.loss += TinyLM.accumulate(M, D.T.X, D.T.Y, S.idx, bt.pos, to, bt.B);
    bt.pos = to;
    if (bt.pos < bt.B) return;
    S.batch = null;
    if (!isFinite(bt.loss)) { S.running = false; S.verdict = 'diverged'; return; }
    TinyLM.adam(M, S.lr);
    S.step++; S.seen += bt.B; S.rateSteps++;
    if (S.step % evalEvery() === 0 || S.step === S.target) queueEval();
    if (S.step % val('every') === 0 || S.step === S.target) queueSample();
  }
  // Evaluation and sampling also run in small pieces, before any further training.
  function work(job) {
    const D = S.D, M = S.M;
    if (job.type === 'eval') {
      if (job.i < D.evTr.length) { const to = Math.min(D.evTr.length, job.i + 2 * CHUNK); job.tr += TinyLM.lossSum(M, D.T.X, D.T.Y, D.evTr, job.i, to); job.i = to; return; }
      if (job.j < D.evVa.length) { const to = Math.min(D.evVa.length, job.j + 2 * CHUNK); job.va += TinyLM.lossSum(M, D.Vd.X, D.Vd.Y, D.evVa, job.j, to); job.j = to; return; }
      S.queue.shift();
      const e = { step: job.step, train: job.tr / D.evTr.length, val: job.va / D.evVa.length };
      if (!isFinite(e.train) || !isFinite(e.val)) { S.running = false; S.verdict = 'diverged'; return; }
      S.evals.push(e);
      judge();
    } else {
      job.out.push(...TinyLM.generate(M, job.ctx, Math.min(40, SAMPLE_LEN - job.out.length), job.temp, job.rng));
      if (job.out.length < SAMPLE_LEN) return;
      S.queue.shift();
      addSample(job);
    }
  }

  // A cooperative loop: about 12 ms of work, then yield so the browser can paint and respond.
  const chan = new MessageChannel();
  let pumping = false;
  chan.port1.onmessage = pump;
  function kick() { if (!pumping) { pumping = true; chan.port2.postMessage(0); } }
  function pump() {
    const t0 = performance.now();
    try {
      while (performance.now() - t0 < SLICE) {
        if (S.queue.length) { work(S.queue[0]); continue; }
        if (!S.running) break;
        if (S.step >= S.target) { S.running = false; break; }
        trainChunk();
      }
    } catch (e) {
      console.error(e);
      S.running = false; S.queue = [];
    }
    scheduleRender();
    if (S.queue.length || S.running) chan.port2.postMessage(0); else pumping = false;
  }

  // ---------- is it learning or memorising? ----------
  function judge() {
    const E = S.evals, n = E.length;
    let ri = 0;
    for (let i = 1; i < n; i++) if (E[i].val < E[ri].val) ri = i;
    S.best = E[ri];
    if (n < 4) { S.verdict = 'learning'; return; }
    // Smooth validation loss over three points so noise does not trigger the warning.
    const sm = E.map((e, i) => { const a = E.slice(Math.max(0, i - 2), i + 1); return a.reduce((s, x) => s + x.val, 0) / a.length; });
    let bi = 0;
    for (let i = 1; i < n; i++) if (sm[i] < sm[bi]) bi = i;
    const last = E[n - 1], since = n - 1 - bi;
    // Levelling off: over the last quarter of the run, validation loss barely moved
    // while training loss kept falling.
    const w = Math.floor(0.75 * (n - 1));
    if (since >= 3 && sm[n - 1] > sm[bi] + Math.max(0.05, 0.04 * sm[bi]) && last.train < E[bi].train - 0.03) S.verdict = 'memorising';
    else if (since >= Math.max(6, 0.15 * n)) { S.verdict = 'plateau'; S.flatFrom = E[bi].step; }
    else if (n >= 12 && sm[w] - sm[n - 1] < 0.03 && E[w].train - last.train > 0.06) { S.verdict = 'plateau'; S.flatFrom = E[w].step; }
    else S.verdict = 'learning';
  }

  // ---------- samples ----------
  function addSample(job) {
    const D = S.D, gen = job.out.map(i => D.chars[i]), cover = new Uint8Array(gen.length);
    let hit = 0, tot = 0;
    for (let i = 0; i + WIN <= gen.length; i++) {
      tot++;
      if (D.windows.has(gen.slice(i, i + WIN).join(''))) { hit++; cover.fill(1, i, i + WIN); }
    }
    let ev = null;
    for (const e of S.evals) if (e.step <= job.step) ev = e;
    const s = { step: job.step, temp: job.temp, gen, seed: D.seedIds.map(i => D.chars[i]), cover, pct: tot ? hit / tot : 0, val: ev ? ev.val : null };
    S.samples.push(s);
    const tl = $('#timeline'), atEnd = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
    tl.insertAdjacentHTML('beforeend', `<div class="tl-item fade-in"><div class="tl-head"><b>Step ${fmtInt(s.step)}</b>${s.val != null ? `<span>validation loss ${s.val.toFixed(2)}</span>` : ''}<span>temperature ${s.temp.toFixed(2)}</span><span>${(s.pct * 100).toFixed(0)}% copied</span></div><div class="tl-text">${sampleHTML(s)}</div></div>`);
    if (atEnd) tl.scrollTop = tl.scrollHeight;
    setMeter(s);
  }
  function sampleHTML(s) {
    let h = `<span class="seed">${esc(s.seed.join(''))}</span>`, run = '', on = 0;
    const flush = () => { if (run) h += on ? `<mark>${esc(run)}</mark>` : esc(run); run = ''; };
    s.gen.forEach((c, i) => { if (s.cover[i] !== on) { flush(); on = s.cover[i]; } run += c; });
    flush();
    return h;
  }
  function setMeter(s) {
    const p = s ? s.pct : 0;
    $('#memoFill').style.width = (p * 100).toFixed(1) + '%';
    $('#memoVal').textContent = s ? (p * 100).toFixed(0) + '%' : '–';
    $('#memoNote').textContent = !s ? 'Appears with the first sample.'
      : p < 0.05 ? `Step ${fmtInt(s.step)}: almost nothing is copied. The model writes new text from patterns it has learned.`
        : p < 0.3 ? `Step ${fmtInt(s.step)}: some stretches come straight from the training text. Common phrases repeat naturally, but long copied runs are a warning sign.`
          : `Step ${fmtInt(s.step)}: much of the sample is recited from the training text. The model is reproducing what it saw rather than writing something new.`;
  }

  // ---------- chart ----------
  const niceStep = (range, target) => {
    const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  };
  let geo = null, hover = null;
  function drawChart() {
    const svg = $('#lossChart'), W = Math.max(280, Math.round($('#chartWrap').clientWidth || 900)), narrow = W < 560;
    const H = narrow ? 250 : 320, l = 40, r = narrow ? 14 : 100, t = 18, b = 38, pw = W - l - r, ph = H - t - b;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const E = S.evals, V = S.D && S.D.ok ? S.D.V : 2, lnV = Math.log(V);
    const xMax = Math.max(S.target, S.step, 10);
    let yMax = lnV * 1.1;
    E.forEach(e => { yMax = Math.max(yMax, e.train, e.val); });
    const ys = niceStep(yMax, 5), yTop = Math.ceil(yMax / ys) * ys, xs = niceStep(xMax, narrow ? 3 : 6);
    const X = s => l + pw * s / xMax, Y = v => t + ph * (1 - v / yTop);
    let g = '';
    for (let v = 0; v <= yTop + 1e-9; v += ys) g += `<line class="grid" x1="${l}" x2="${l + pw}" y1="${Y(v)}" y2="${Y(v)}"></line><text x="${l - 7}" y="${Y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`;
    for (let s = 0; s <= xMax + 1e-9; s += xs) {
      const x = X(s);
      g += `<text x="${x}" y="${t + ph + 16}" text-anchor="${x > W - 24 ? 'end' : 'middle'}">${fmtInt(s)}</text>`;
    }
    g += `<line class="axis" x1="${l}" x2="${l + pw}" y1="${t + ph}" y2="${t + ph}"></line>`;
    g += `<text x="${l - 7}" y="${t - 6}" text-anchor="start">loss</text><text x="${l + pw}" y="${H - 4}" text-anchor="end">training steps</text>`;
    if (S.verdict === 'memorising' && S.best && E.length) {
      const x0 = X(S.best.step), x1 = X(E[E.length - 1].step), endAnchor = x0 > l + pw - 230;
      g += `<rect class="zone" x="${x0}" y="${t}" width="${Math.max(0, x1 - x0)}" height="${ph}"></rect>`;
      g += `<text class="lbl" x="${endAnchor ? x1 - 6 : x0 + 6}" y="${t + 13}" text-anchor="${endAnchor ? 'end' : 'start'}">memorising: validation loss rising</text>`;
    }
    const yb = Y(lnV);
    g += `<line class="base" x1="${l}" x2="${l + pw}" y1="${yb}" y2="${yb}"></line>`;
    $('#baseKey').textContent = `Uniform guess: ln ${V} = ${lnV.toFixed(2)}`;
    const path = key => E.map((e, i) => `${i ? 'L' : 'M'}${X(e.step).toFixed(1)} ${Y(e[key]).toFixed(1)}`).join('');
    if (E.length > 1) g += `<path class="ln tr" d="${path('train')}"></path><path class="ln va" d="${path('val')}"></path>`;
    if (S.best && E.length > 2) {
      const bx = X(S.best.step), by = Y(S.best.val);
      g += `<circle class="best" cx="${bx}" cy="${by}" r="4.5"></circle>`;
      if (S.verdict === 'memorising') g += `<text class="lbl" x="${bx}" y="${by + 20}" text-anchor="${bx < l + 70 ? 'start' : 'middle'}">lowest validation loss</text>`;
    }
    if (!narrow) {
      // Direct labels at the line ends, pushed apart where they would overlap.
      const labs = [{ x: l + pw + 8, y: yb, text: 'uniform guess' }];
      if (E.length > 1) {
        const last = E[E.length - 1], x = X(last.step) + 8;
        labs.push({ x, y: Y(last.train), text: 'training' }, { x, y: Y(last.val), text: 'validation' });
      }
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) {
          const a = labs[i], c = labs[j];
          if (Math.abs(a.x - c.x) < 90 && Math.abs(a.y - c.y) < 13) { const m = (a.y + c.y) / 2, up = a.y <= c.y ? -1 : 1; a.y = m + 6.5 * up; c.y = m - 6.5 * up; }
        }
      }
      labs.forEach(o => { g += `<text class="end" x="${o.x}" y="${o.y + 4}">${o.text}</text>`; });
    }
    g += `<g id="xh" style="display:none"><line class="xh" y1="${t}" y2="${t + ph}"></line><circle class="dot tr" r="4.5"></circle><circle class="dot va" r="4.5"></circle></g>`;
    g += `<rect class="hit" x="${l}" y="${t}" width="${pw}" height="${ph}"></rect>`;
    svg.innerHTML = g;
    geo = { W, l, pw, X, Y, xMax };
    if (hover) showHover();
  }
  function onHover(e) {
    const E = S.evals;
    if (!geo || !E.length) return;
    const rc = $('#lossChart').getBoundingClientRect(), x = (e.clientX - rc.left) * geo.W / rc.width;
    if (x < geo.l - 8 || x > geo.l + geo.pw + 8) { hideHover(); return; }
    const s = (x - geo.l) / geo.pw * geo.xMax;
    let lo = 0, hi = E.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (E[m].step < s) lo = m; else hi = m; }
    hover = { e, i: Math.abs(E[lo].step - s) <= Math.abs(E[hi].step - s) ? lo : hi };
    showHover();
  }
  function showHover() {
    const ev = S.evals[hover.i], xh = $('#xh');
    if (!ev || !xh) return;
    const x = geo.X(ev.step);
    xh.style.display = '';
    const [ln, d1, d2] = xh.children;
    ln.setAttribute('x1', x); ln.setAttribute('x2', x);
    d1.setAttribute('cx', x); d1.setAttribute('cy', geo.Y(ev.train));
    d2.setAttribute('cx', x); d2.setAttribute('cy', geo.Y(ev.val));
    Site.tip(`<div>Step ${fmtInt(ev.step)}</div>
      <div class="tt-row"><i class="tt-key" style="--c:var(--s1)"></i><b>${ev.train.toFixed(3)}</b> training loss</div>
      <div class="tt-row"><i class="tt-key" style="--c:var(--s2)"></i><b>${ev.val.toFixed(3)}</b> validation loss</div>
      <div class="tt-sub">On held-out text the right character gets ${pctOf(ev.val)} on average.</div>`, hover.e);
  }
  function hideHover() {
    hover = null;
    const xh = $('#xh');
    if (xh) xh.style.display = 'none';
    Site.tip(null);
  }
  const chartEl = $('#lossChart');
  chartEl.addEventListener('pointermove', onHover);
  chartEl.addEventListener('pointerleave', hideHover);
  if (window.ResizeObserver) new ResizeObserver(() => drawChart()).observe($('#chartWrap'));

  function fillTable() {
    const E = S.evals, every = Math.max(1, Math.ceil(E.length / 60));
    const rows = E.filter((e, i) => i % every === 0 || i === E.length - 1);
    $('#lossTable').innerHTML = `<thead><tr><th class="num">Step</th><th class="num">Training loss</th><th class="num">Validation loss</th><th class="num">Gap</th></tr></thead><tbody>${rows.map(e =>
      `<tr><td class="num">${fmtInt(e.step)}</td><td class="num">${e.train.toFixed(3)}</td><td class="num">${e.val.toFixed(3)}</td><td class="num">${(e.val - e.train).toFixed(3)}</td></tr>`).join('')}</tbody>`;
  }

  // ---------- page state ----------
  const ICON = {
    ok: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" style="fill:var(--good)"></circle><path class="glyph" d="M4.6 8.3l2.2 2.2 4.6-4.9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7.3 13.3H.7z" style="fill:var(--warn)"></path><path class="glyph" d="M8 5.8v4.2" stroke-width="1.8" stroke-linecap="round"></path><circle class="glyph-dot" cx="8" cy="12.3" r="1"></circle></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" style="fill:var(--muted)"></circle><path class="glyph" d="M8 7v4.6" stroke-width="1.8" stroke-linecap="round"></path><circle class="glyph-dot" cx="8" cy="4.5" r="1"></circle></svg>',
    bad: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" style="fill:var(--bad)"></circle><path class="glyph" d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke-width="1.8" stroke-linecap="round"></path></svg>'
  };
  function verdictHTML() {
    const E = S.evals, last = E[E.length - 1], b = S.best;
    if (!S.D || !S.D.ok) return ['bad', 'No model yet.', 'Add more training text above.'];
    const state = S.verdict === 'diverged' ? 'diverged' : S.step === 0 ? 'idle' : S.verdict;
    switch (state) {
      case 'idle': return ['info', 'Ready.', 'The weights are random, so every character gets roughly the same probability. That is why both losses start on the dashed line. Press Train.'];
      case 'learning': return ['ok', 'Learning.', 'Both losses are falling. What the model picks up from the training text also works on text it has never seen.'];
      case 'plateau': return ['info', 'Levelling off.', `Validation loss has barely improved since step ${fmtInt(S.flatFrom)}, while training loss keeps falling. More steps now mostly help on the training text, which is where memorising starts.`];
      case 'memorising': return ['warn', 'The model has started memorising.', `Validation loss bottomed out at ${b.val.toFixed(2)} at step ${fmtInt(b.step)} and is now ${last.val.toFixed(2)}. Training loss kept falling, to ${last.train.toFixed(2)}. The model is learning this exact text, not patterns that carry over. Stopping at step ${fmtInt(b.step)} would have given the better model.`];
      default: return ['bad', 'Training broke down.', 'The loss stopped being a finite number. That usually means the learning rate is too high. Lower it and press Reset.'];
    }
  }
  let lastChart = 0, rq = false, lastVerdict = '';
  function scheduleRender() {
    if (rq) return;
    rq = true;
    requestAnimationFrame(() => { rq = false; render(false); });
  }
  function render(force) {
    const E = S.evals, last = E[E.length - 1], D = S.D, now = performance.now();
    if (S.running && now - S.rateT > 800) { S.rate = S.rateSteps * 1000 / (now - S.rateT); S.rateT = now; S.rateSteps = 0; }
    $('#sStep').textContent = fmtInt(S.step);
    $('#sStepK').textContent = `steps of ${fmtInt(S.target)}` + (S.running && S.rate ? `, ${fmtInt(S.rate)} a second` : '');
    $('#sTrain').textContent = last ? last.train.toFixed(2) : '–';
    $('#sVal').textContent = last ? last.val.toFixed(2) : '–';
    $('#sValK').textContent = last ? `validation loss: the right character gets ${pctOf(last.val)} on average` : 'validation loss';
    $('#sBest').textContent = S.best ? S.best.val.toFixed(2) : '–';
    $('#sBestK').textContent = S.best ? `lowest validation loss, at step ${fmtInt(S.best.step)}` : 'lowest validation loss';
    $('#sEpoch').textContent = D && D.ok ? (S.seen / D.T.n).toFixed(1) : '–';
    const [cls, title, body] = verdictHTML(), html = `${ICON[cls]}<div><b>${title}</b> ${body}${S.note ? ` <span class="muted">${esc(S.note)}</span>` : ''}</div>`;
    if (html !== lastVerdict) { const v = $('#verdict'); v.className = 'verdict ' + cls; v.innerHTML = html; lastVerdict = html; }
    const ok = !!(D && D.ok), done = S.step >= S.target;
    $('#train').disabled = !ok || S.running;
    $('#train').textContent = S.step === 0 ? 'Train' : done ? 'Train more' : 'Resume';
    $('#pause').disabled = !S.running;
    $('#reset').disabled = !ok;
    $('#sampleNow').disabled = !ok;
    $('#progress i').style.width = (100 * Math.min(1, (S.step - S.runStart) / Math.max(1, S.target - S.runStart))).toFixed(1) + '%';
    if (force || !S.running || now - lastChart > 120) {
      lastChart = now;
      drawChart();
      if ($('#tbl').open) fillTable();
    }
  }

  // ---------- controls ----------
  function setPreset(p) {
    S.preset = p; S.nAll = true;
    $$('#presets .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.p === p));
    $('#text').value = p === 'own' ? S.own : DATA[p];
  }
  function clearScenario() { $$('.scen').forEach(b => b.classList.remove('on')); }
  const freshNote = () => (S.step > 0 ? 'You changed the data or the shape of the model, so this is a fresh model.' : '');
  function runScenario(name) {
    const sc = SCENARIOS[name];
    setPreset(sc.preset);
    const len = Array.from($('#text').value).length;
    S.nAll = !sc.n;
    $('#nChars').max = len; $('#nChars').value = sc.n || len;
    ['k', 'd', 'H', 'lr', 'B', 'steps'].forEach(id => ($('#' + id).value = sc[id]));
    $('#seed').value = 42;
    labels(); reset();
    $$('.scen').forEach(b => b.classList.toggle('on', b.dataset.s === name));
    start();
  }
  function start() {
    if (!S.M || S.running) return;
    if (S.step >= S.target) { S.runStart = S.step; S.target = S.step + val('steps'); }
    S.note = '';
    S.running = true; S.rateT = performance.now(); S.rateSteps = 0; S.rate = 0;
    kick(); render(true);
  }

  $('#presets').addEventListener('click', e => {
    const b = e.target.closest('.chip-btn');
    if (!b) return;
    setPreset(b.dataset.p); clearScenario(); reset(freshNote());
    if (b.dataset.p === 'own') $('#text').focus();
  });
  let typing = null;
  $('#text').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      if (S.preset !== 'own') { S.preset = 'own'; $$('#presets .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.p === 'own')); }
      S.own = $('#text').value; clearScenario(); reset(freshNote());
    }, 400);
  });
  $('#nChars').addEventListener('input', e => { S.nAll = +e.target.value >= +e.target.max; clearScenario(); reset(freshNote()); });
  ['k', 'd', 'H', 'seed'].forEach(id => $('#' + id).addEventListener('input', () => { labels(); clearScenario(); reset(freshNote()); }));
  $('#lr').addEventListener('input', () => { labels(); clearScenario(); S.lr = Math.pow(10, val('lr')); });
  $('#B').addEventListener('change', () => { clearScenario(); S.B = val('B'); });
  $('#steps').addEventListener('input', () => {
    labels(); clearScenario();
    S.target = Math.max(S.step, S.runStart + val('steps'));
    render(true);
  });
  $('#temp').addEventListener('input', labels);
  $('#train').addEventListener('click', start);
  $('#pause').addEventListener('click', () => { S.running = false; render(true); });
  $('#reset').addEventListener('click', () => reset());
  $('#sampleNow').addEventListener('click', () => { if (S.M) { queueSample(); kick(); } });
  $$('.scen').forEach(b => b.addEventListener('click', () => runScenario(b.dataset.s)));
  $('#overfitGo').addEventListener('click', () => {
    runScenario('overfit');
    $('#trainCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#tbl').addEventListener('toggle', () => { if ($('#tbl').open) fillTable(); });

  setPreset('austen');
  labels();
  reset();
})();
