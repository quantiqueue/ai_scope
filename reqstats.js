// AI_SCOPE-094 slice 3: one token-weighted average builder, shared by the scopes' idle numbers.
//
// Five copies existed (Strata gen, Strata prompt, Ollama, llama.cpp, Bionic). What varied between
// them is app knowledge - which model to weigh, which field holds the tokens, whether a per-request
// TIME exists at all - so that stays with the caller. What they each re-implemented, identically or
// nearly so, is the weighting itself: sum the tokens, sum the time they took, divide. That is here.
//
// Token-weighted, not a mean of the speeds: a 2,000-token request and a 20-token one must not count
// the same. The caller decides the window (the last N saved requests) and what to do when the app
// reports only a rate and no duration (llama.cpp: seconds are implied by tokens / rate).
//
// Returns { value, requests } or null when nothing qualifies. It never invents a number: a row with
// no usable tokens or no usable time is skipped, exactly as the old per-scope code skipped it.

function avgSpeed(rows, model, o) {
  o = o || {};
  const tokensField = o.tokensField || 'outputTokens';
  const limit = o.limit === undefined ? 20 : o.limit;      // null / undefined-per-call = take all
  const anyModel = !!o.anyModel;
  const picked = [];
  // Scan newest-first: the scope arrays are saved oldest-first, so the tail is the recent end.
  for (let i = rows.length - 1; i >= 0 && (limit == null || picked.length < limit); i--) {
    const r = rows[i];
    if (!r) continue;
    if (!anyModel && r.model !== model) continue;
    const tok = r[tokensField];
    if (!(tok > 0)) continue;
    let sec = null;
    if (o.timeField) {
      const ms = r[o.timeField];
      if (ms > 0) sec = ms / 1000;
    }
    if (sec == null && o.rateField) {
      const rate = r[o.rateField];
      if (rate > 0) sec = tok / rate;
    }
    if (!(sec > 0)) continue;
    picked.push({ tok: tok, sec: sec });
  }
  if (!picked.length) return null;
  let t = 0, s = 0;
  picked.forEach(function (p) { t += p.tok; s += p.sec; });
  if (!(s > 0)) return null;
  return { value: t / s, requests: picked.length, tokens: t, seconds: s };
}

// ---------- AI_SCOPE-094 slice 4: one provenance vocabulary for every number on a record ----------
// Four dialects of the same question existed (llama.cpp exact / genExact / outputEstimated / quick,
// Ollama measured, Strata genDerived, Bionic firstTokenDerived). They asked the same thing: where did
// this number come from? So a record now answers it per field, in four words.
//
//   exact       the app measured this quantity and reported it
//   derived     AI_SCOPE did one arithmetic step on the app's own reported numbers (tokens ÷ time,
//               the difference between two counters). Trustworthy, just not measured as such.
//   estimated   AI_SCOPE reconstructed it from polling or interpolation - no per-request measurement
//               backs the number, so a table shows it with ≈, as llama.cpp has always done.
//   substitute  the value answers a DIFFERENT question from the one the column asks: a prefill
//               duration sitting in the First token column because the app reports no first-token
//               time at all. Shown with ≈ and its reason spelled out - it is not a measurement of
//               the quantity the header names.
//
// A field with no entry is the app's own number (exact). A number that does not exist is absent,
// which is a gap on screen - never a zero and never an average (the 072 rule).
// `quick` stays what it always was: a statement about what the observer could see, not about a
// number's arithmetic. It belongs with the row, not the field.
const PROV = { EXACT: 'exact', DERIVED: 'derived', ESTIMATED: 'estimated', SUBSTITUTE: 'substitute' };
const MARKED = { estimated: true, substitute: true };   // the two kinds a table shows with ≈

function setProv(r, field, kind) {
  if (!r) return;
  if (kind === PROV.EXACT) { if (r.src) delete r.src[field]; return; }   // the default needs no bytes on disk
  (r.src = r.src || {})[field] = kind;
}
function prov(r, field) {
  const s = r && r.src;
  return (s && s[field]) || PROV.EXACT;
}
// The one question the tables ask: does this number need a marker?
function isMarked(r, field) { return !!MARKED[prov(r, field)]; }

module.exports = { avgSpeed: avgSpeed, PROV: PROV, setProv: setProv, prov: prov, isMarked: isMarked };
