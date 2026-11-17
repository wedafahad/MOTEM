const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Calc = require('../docs/js/calc.js');

function loadServer() {
  const ctx = vm.createContext({ Logger: { log() {} } });
  vm.runInContext(fs.readFileSync('api/Code.gs', 'utf8'), ctx);
  return ctx;
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('defaults: weights sum to 100 for both levels; reliability is behavioral with N/A', () => {
  const d = loadServer().DEFAULT_SETTINGS_();
  for (const k of ['weightWriter', 'weightSenior']) assert.equal(d.pillars.reduce((s, p) => s + p[k], 0), 100);
  const rel = d.pillars.find((p) => p.id === 'reliability');
  assert.equal(rel.category, 'behavioral');
  assert.equal(rel.weightWriter, 5);
  assert.equal(rel.weightSenior, 5);
  assert.equal(rel.allowNotApplicable, true);
  const q = d.pillars.find((p) => p.id === 'quality');
  assert.equal(q.weightWriter, 55);
  assert.equal(q.weightSenior, 40);
  assert.equal(q.reviewCriteria.reduce((s, c) => s + c.weight, 0), 100);
});

test('tiered revision rounds: short 1→5, 2-4→3, 5+→1; long 4→5, 5-10→3, 11+→1', () => {
  const c = loadServer().DEFAULT_REVISION_ROUNDS_CRITERION_();
  const sc = (cat, r) => Calc.revisionTierScore({ workCategory: cat, contentRevisionRounds: r }, c);
  assert.deepEqual([0, 1, 2, 4, 5].map((r) => sc('نص إعلاني', r)), [5, 5, 3, 3, 1]);
  assert.deepEqual([4, 5, 10, 11].map((r) => sc('التقرير السنوي', r)), [5, 3, 3, 1]);
  assert.equal(sc('الحملات الإعلانية', 7), 3);
  assert.equal(sc('تقرير مشروع + متخصص', 11), 1);
  assert.equal(sc('الملف التعريفي', 5), 1); // ليس ضمن الفئة الطويلة
  const m = Calc.computeMetrics([
    { delivered: true, workCategory: 'نص إعلاني', contentRevisionRounds: 1 },
    { delivered: true, workCategory: 'التقرير السنوي', contentRevisionRounds: 8 },
  ], { revisionCriterion: c });
  assert.equal(m.revisionRoundsScore, 4);
});

test('non-evaluated works: count in discipline metrics, not in revision rounds', () => {
  const evaluable = [{ id: 'a', delivered: true, onTime: true, contentRevisionRounds: 1 }];
  const all = evaluable.concat([{ id: 'x', delivered: true, onTime: false, contentRevisionRounds: 9 }, { id: 'y', delivered: false }]);
  const m = Calc.computeMetrics(evaluable, { allRows: all });
  assert.equal(m.avgContentRevisionRounds, 1);
  assert.equal(m.onTimeRate, 50);
  assert.ok(near(m.taskCompletionRate, 200 / 3));
});

test('quality: writing-only result unchanged; review works use reviewer criteria', () => {
  const pillar = {
    criteria: [{ id: 'c1', weightCreative: 60, weightFormal: 60 }, { id: 'c2', weightCreative: 40, weightFormal: 40 }],
    reviewActionType: 'مراجعة وتدقيق',
    reviewCriteria: [{ id: 'r1', weight: 50 }, { id: 'r2', weight: 50 }],
  };
  const rows = [
    { id: 'w1', actionType: 'كتابة', workType: 'creative' },
    { id: 'w2', actionType: 'كتابة', workType: 'creative', isRevision: true },
    { id: 'rv', actionType: 'مراجعة وتدقيق', workType: 'formal' },
  ];
  // كتابة فقط: مطابق للطريقة القديمة (متوسط كل معيار × وزنه)
  const w = Calc.computeQualityPillar(pillar, { w1: { c1: 5, c2: 3 }, w2: { c1: 2, c2: 4 } }, ['w1', 'w2'], 'creative', rows, 0.5);
  const avgC1 = (5 + 2 * 0.5) / 1.5, avgC2 = (3 + 4 * 0.5) / 1.5;
  assert.ok(near(w.pillarScore, avgC1 * 0.6 + avgC2 * 0.4));
  // مع عمل مراجعة: يُقيَّم ببنود المراجع فقط
  const perSample = { w1: { c1: 5, c2: 3 }, rv: { r1: 2, r2: 4 } };
  const r = Calc.computeQualityPillar(pillar, perSample, ['w1', 'rv'], 'creative', rows, 0.5);
  assert.equal(r.reviewWorkCount, 1);
  assert.ok(near(r.perWorkScore.w1, 4.2));
  assert.ok(near(r.perWorkScore.rv, 3));
  assert.ok(near(r.pillarScore, 3.6));
  assert.equal(r.criteriaAvg.c1, 5);
  assert.equal(r.reviewCriteriaAvg.r1, 2);
  // عمل مراجعة غير مكتمل ببنود المراجع → الركيزة غير مكتملة
  const inc = Calc.computeQualityPillar(pillar, { w1: { c1: 5, c2: 3 }, rv: { c1: 5, c2: 5 } }, ['w1', 'rv'], 'creative', rows, 0.5);
  assert.equal(inc.pillarScore, null);
});

test('reliability N/A redistributes its weight; otherwise identical to /100', () => {
  const settings = {
    pillars: [
      { id: 'p', weightWriter: 95, weightSenior: 95, criteria: [{ id: 'c', weight: 100 }] },
      { id: 'reliability', allowNotApplicable: true, weightWriter: 5, weightSenior: 5, criteria: [{ id: 'r', weight: 100 }] },
    ],
    classification: [{ min: 0, max: 5, label: 'x' }],
  };
  const emp = { level: 'writer' };
  assert.equal(Calc.computeFullEvaluation(settings, emp, { p: { criteriaScores: { c: 4 } }, reliability: { criteriaScores: { r: 2 } } }, []).totalScore, 3.9);
  const na = Calc.computeFullEvaluation(settings, emp, { p: { criteriaScores: { c: 4 } }, reliability: { notApplicable: true } }, []);
  assert.equal(na.totalScore, 4);
  assert.equal(na.pillars.reliability.notApplicable, true);
  // بلا درجة وبلا «لا ينطبق» → غير مكتمل
  assert.equal(Calc.computeFullEvaluation(settings, emp, { p: { criteriaScores: { c: 4 } } }, []).totalScore, null);
});

test('migration V3 on live-shaped settings: idempotent, keeps sums at 100', () => {
  const ctx = loadServer();
  const old = ctx.DEFAULT_SETTINGS_();
  old.pillars = old.pillars.filter((p) => p.id !== 'reliability');
  const q = old.pillars.find((p) => p.id === 'quality');
  q.weightWriter = 60; q.weightSenior = 45;
  delete q.reviewCriteria; delete q.reviewActionType;
  const rr = q && old.pillars.find((p) => p.id === 'client_satisfaction').criteria.find((c) => c.id === 'revision_rounds');
  delete rr.tiers; delete rr.longCategories; rr.metric = 'avgContentRevisionRounds';
  let stored = JSON.parse(JSON.stringify(old));
  ctx.getSettings_ = () => JSON.parse(JSON.stringify(stored));
  ctx.setSettings_ = (s) => { stored = JSON.parse(JSON.stringify(s)); };
  ctx.audit_ = () => {};
  vm.runInContext('migrateV3_reliabilityReviewTiers()', ctx);
  vm.runInContext('migrateV3_reliabilityReviewTiers()', ctx); // تشغيل ثانٍ لا يكرّر شيئًا
  const quality = stored.pillars.find((p) => p.id === 'quality');
  assert.equal(quality.weightWriter, 55);
  assert.equal(quality.weightSenior, 40);
  assert.equal(stored.pillars.filter((p) => p.id === 'reliability').length, 1);
  assert.equal(quality.reviewCriteria.length, 5);
  const rev = stored.pillars.find((p) => p.id === 'client_satisfaction').criteria.find((c) => c.id === 'revision_rounds');
  assert.ok(rev.tiers && rev.metric === 'revisionRoundsScore');
  for (const k of ['weightWriter', 'weightSenior']) assert.equal(stored.pillars.reduce((s, p) => s + p[k], 0), 100);
});

test('past quarters: reliability auto N/A before 2026-Q4, required from 2026-Q4', () => {
  const settings = {
    pillars: [
      { id: 'p', weightWriter: 95, weightSenior: 95, criteria: [{ id: 'c', weight: 100 }] },
      { id: 'reliability', allowNotApplicable: true, weightWriter: 5, weightSenior: 5, criteria: [{ id: 'r', weight: 100 }] },
    ],
    classification: [{ min: 0, max: 5, label: 'x' }],
  };
  const emp = { level: 'writer' };
  const input = { p: { criteriaScores: { c: 4 } } };
  const old = Calc.computeFullEvaluation(settings, emp, input, [], { quarter: '2026-Q2' });
  assert.equal(old.totalScore, 4);
  assert.equal(old.pillars.reliability.notIntroduced, true);
  assert.equal(Calc.computeFullEvaluation(settings, emp, input, [], { quarter: '2025-Q4' }).totalScore, 4);
  assert.equal(Calc.computeFullEvaluation(settings, emp, input, [], { quarter: '2026-Q4' }).totalScore, null);
  assert.equal(Calc.computeFullEvaluation(settings, emp, input, [], { quarter: '2027-Q1' }).totalScore, null);
});
