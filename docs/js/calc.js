// محرك الاحتساب — نظام «متم». دوال خالصة (pure) قابلة للاختبار بمعزل عن الواجهة.
// يعتمد كليًا على إعدادات المعايير القادمة من الخادم (Settings) — لا أرقام ثابتة هنا.

const Calc = (() => {
  /** يحوّل قيمة مقياس (نسبة/عدد) إلى درجة 1-5 متصلة بناءً على نقاط الارتكاز 5/3/1. */
  function scoreFromBand(value, bands, higherIsBetter) {
    if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) || !bands) return null;
    value = Number(value);
    const b5 = bands["5"], b3 = bands["3"], b1 = bands["1"];
    if (![b5, b3, b1].every(Number.isFinite)) return null;
    if (higherIsBetter ? !(b5 > b3 && b3 > b1) : !(b5 < b3 && b3 < b1)) return null;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    if (higherIsBetter) {
      if (value >= b5) return 5;
      if (value <= b1) return 1;
      if (value >= b3) return clamp(3 + ((value - b3) / (b5 - b3)) * 2, 3, 5);
      return clamp(1 + ((value - b1) / (b3 - b1)) * 2, 1, 3);
    } else {
      if (value <= b5) return 5;
      if (value >= b1) return 1;
      if (value <= b3) return clamp(5 - ((value - b5) / (b3 - b5)) * 2, 3, 5);
      return clamp(3 - ((value - b3) / (b1 - b3)) * 2, 1, 3);
    }
  }

  /** النوع الذي يجعل العمل "عمل مراجعة" يُقيَّم ببنود المراجع بدل بنود الكتابة. */
  const DEFAULT_REVIEW_ACTION_TYPE = "مراجعة وتدقيق";
  function isReviewWork(work, qualityPillar) {
    if (!work) return false;
    const reviewType = (qualityPillar && qualityPillar.reviewActionType) || DEFAULT_REVIEW_ACTION_TYPE;
    return !!(qualityPillar && Array.isArray(qualityPillar.reviewCriteria) && qualityPillar.reviewCriteria.length) &&
      work.actionType === reviewType;
  }

  /** درجة جولات التعديل لعمل واحد (1/3/5) حسب فئته: قصير أو طويل (تقرير سنوي، متخصص، حملات...). */
  function revisionTierScore(work, criterion) {
    const tiers = criterion && criterion.tiers;
    if (!tiers) return null;
    const longCats = Array.isArray(criterion.longCategories) ? criterion.longCategories : [];
    const tier = longCats.indexOf(work.workCategory) !== -1 ? tiers.long : tiers.short;
    if (!tier || !Number.isFinite(Number(tier["5"])) || !Number.isFinite(Number(tier["3"]))) return null;
    const rounds = Number(work.contentRevisionRounds) || 0;
    if (rounds <= Number(tier["5"])) return 5;
    if (rounds <= Number(tier["3"])) return 3;
    return 1;
  }

  /**
   * مقاييس ركيزتي "رضا العميل" و"الانضباط" من سجل الأعمال الفعلي لموظف/ربع معيّن.
   * workRows: الأعمال الخاضعة للتقييم (تغذّي جولات التعديل).
   * opts.allRows: كل أعمال الربع بما فيها غير الخاضعة للتقييم (تغذّي التسليم بالموعد ونسبة الإنجاز) — إن لم تُمرَّر تُستخدم workRows.
   * opts.revisionCriterion: معيار جولات التعديل المتدرّج حسب الفئة (إن وُجد) لحساب revisionRoundsScore.
   */
  function computeMetrics(workRows, opts) {
    workRows = Array.isArray(workRows) ? workRows : [];
    opts = opts || {};
    const allRows = Array.isArray(opts.allRows) ? opts.allRows : workRows;
    const deliveredEvaluable = workRows.filter((w) => w.delivered);
    const avgContentRevisionRounds = deliveredEvaluable.length
      ? deliveredEvaluable.reduce((s, w) => s + (Number(w.contentRevisionRounds) || 0), 0) / deliveredEvaluable.length
      : null;
    let revisionRoundsScore = null;
    if (opts.revisionCriterion && deliveredEvaluable.length) {
      const scores = deliveredEvaluable.map((w) => revisionTierScore(w, opts.revisionCriterion)).filter((v) => v !== null);
      revisionRoundsScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    }
    const deliveredAll = allRows.filter((w) => w.delivered);
    const total = allRows.length;
    const onTimeRate = deliveredAll.length
      ? (100 * deliveredAll.filter((w) => w.onTime).length) / deliveredAll.length
      : null;
    const taskCompletionRate = total ? (100 * deliveredAll.length) / total : null;
    const out = { avgContentRevisionRounds, onTimeRate, taskCompletionRate };
    if (opts.revisionCriterion) out.revisionRoundsScore = revisionRoundsScore;
    return out;
  }

  /**
   * الربع الذي بدأ فيه تطبيق ركيزة. تقييمات الأرباع السابقة له تُعامَل فيها الركيزة كـ«لا ينطبق» تلقائيًا
   * (حتى لا يصير تقييم ربع قديم ناقصًا عند فتحه وحفظه بعد إضافة ركيزة جديدة).
   * الاعتمادية أُضيفت في 2026-Q4؛ القيمة الافتراضية لها تغطّي الإعدادات المرحَّلة قبل وجود هذا الحقل.
   */
  function pillarIntroducedQuarter(pillar) {
    if (pillar && pillar.introducedQuarter) return pillar.introducedQuarter;
    return pillar && pillar.id === "reliability" ? "2026-Q4" : null;
  }
  function pillarNotYetIntroduced(pillar, quarter) {
    const q0 = pillarIntroducedQuarter(pillar);
    return !!(q0 && quarter && String(quarter) < String(q0));
  }

  /** يجد معيار جولات التعديل المتدرّج (tiers) في الإعدادات إن وُجد. */
  function findTieredRevisionCriterion(settings) {
    for (const p of (settings && settings.pillars) || []) {
      for (const c of p.criteria || []) if (c.type === "ratio" && c.tiers) return c;
    }
    return null;
  }

  /** نسبة مزيج الإبداعي/الرسمي هذا الربع — يُستخدم لتحديد أوزان معايير الجودة لكاتب "عام". */
  function creativeMix(workRows) {
    workRows = Array.isArray(workRows) ? workRows : [];
    const withValue = workRows.filter((w) => w.workType === "creative" || w.workType === "formal");
    if (!withValue.length) return 0.5; // لا بيانات كافية -> توزيع متساوٍ افتراضيًا
    const creative = withValue.filter((w) => w.workType === "creative").length;
    return creative / withValue.length;
  }

  /** الوزن الفعّال لكل معيار جودة حسب تخصص الكاتب (إبداعي/رسمي/عام). */
  function effectiveQualityWeights(qualityPillar, specialty, workRowsForMix) {
    const weights = {};
    let ratioCreative;
    if (specialty === "creative") ratioCreative = 1;
    else if (specialty === "formal") ratioCreative = 0;
    else ratioCreative = creativeMix(workRowsForMix || []);
    for (const c of qualityPillar.criteria) {
      weights[c.id] = ratioCreative * c.weightCreative + (1 - ratioCreative) * c.weightFormal;
    }
    return weights;
  }

  /**
   * درجة ركيزة الجودة: كل عمل يُقيَّم ببنوده (بنود الكتابة، أو بنود المراجع لأعمال «مراجعة وتدقيق»)،
   * فتُحسب درجة مركّبة لكل عمل، ثم معدّلها المرجَّح عبر كل الأعمال (عمل "مراجعة لعمل سابق" بقيمة مخفَّضة).
   * لعمل الكتابة النتيجة مطابقة رياضيًا للطريقة السابقة (متوسط كل معيار × وزنه).
   */
  function computeQualityPillar(qualityPillar, perSample, sampleWorkIds, specialty, workRowsForMix, revisionMultiplier) {
    const weights = effectiveQualityWeights(qualityPillar, specialty, workRowsForMix);
    const reviewCriteria = Array.isArray(qualityPillar.reviewCriteria) ? qualityPillar.reviewCriteria : [];
    const reviewWeightSum = reviewCriteria.reduce((s, c) => s + (Number(c.weight) || 0), 0) || 100;
    const reviewWeights = {};
    reviewCriteria.forEach((c) => { reviewWeights[c.id] = Number(c.weight) || 0; });
    const mult = revisionMultiplier === undefined || revisionMultiplier === null ? 1 : revisionMultiplier;
    const rowOf = (wid) => (workRowsForMix || []).find((r) => r.id === wid);
    const weightOfSample = (wid) => {
      const w = rowOf(wid);
      return w && w.isRevision ? mult : 1;
    };
    const valid = (v) => !(v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) || Number(v) < 1 || Number(v) > 5);

    const writingIds = [], reviewIds = [];
    sampleWorkIds.forEach((wid) => (isReviewWork(rowOf(wid), qualityPillar) ? reviewIds : writingIds).push(wid));

    let samplesComplete = sampleWorkIds.length > 0;
    const avgOver = (ids, crits) => {
      const avg = {};
      for (const c of crits) {
        let ws = 0, wsum = 0;
        ids.forEach((wid) => {
          const v = perSample?.[wid]?.[c.id];
          if (!valid(v)) { samplesComplete = false; return; }
          const w = weightOfSample(wid);
          ws += Number(v) * w;
          wsum += w;
        });
        avg[c.id] = wsum > 0 ? ws / wsum : null;
      }
      return avg;
    };
    const criteriaAvg = avgOver(writingIds, qualityPillar.criteria);
    const reviewCriteriaAvg = avgOver(reviewIds, reviewCriteria);

    // درجة مركّبة لكل عمل
    const perWorkScore = {};
    let num = 0, den = 0;
    sampleWorkIds.forEach((wid) => {
      const isRev = reviewIds.indexOf(wid) !== -1;
      const crits = isRev ? reviewCriteria : qualityPillar.criteria;
      if (!crits.every((c) => valid(perSample?.[wid]?.[c.id]))) return;
      const score = isRev
        ? crits.reduce((s, c) => s + Number(perSample[wid][c.id]) * reviewWeights[c.id], 0) / reviewWeightSum
        : crits.reduce((s, c) => s + (Number(perSample[wid][c.id]) * weights[c.id]) / 100, 0);
      perWorkScore[wid] = score;
      const m = weightOfSample(wid);
      num += score * m;
      den += m;
    });
    const pillarScore = samplesComplete && den > 0 ? num / den : null;
    return {
      criteriaAvg, reviewCriteriaAvg, weights, reviewWeights, perWorkScore, pillarScore,
      writingWorkCount: writingIds.length, reviewWorkCount: reviewIds.length,
    };
  }

  /** ركيزة مؤشرات مباشرة (تفاعل / انضباط الشق الرقابي / نمو) — درجات يدوية بأوزان معيار لكل معيار. */
  function computeFlatPillar(pillar, criteriaScores, level) {
    const applicable = pillar.criteria.filter((c) => !c.appliesToLevel || c.appliesToLevel === level);
    const totalWeight = applicable.reduce((s, c) => s + (c.weight || 0), 0) || 100;
    let sum = 0;
    let complete = true;
    for (const c of applicable) {
      const v = criteriaScores[c.id];
      if (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) || Number(v) < 1 || Number(v) > 5) {
        complete = false;
        continue;
      }
      sum += (Number(v) * (c.weight || 0)) / totalWeight;
    }
    return { pillarScore: complete ? sum : null };
  }

  /** الدرجة التلقائية لمعيار ratio: المتدرّج حسب الفئة (tiers) يأتي درجةً جاهزة، والباقي يُحوَّل عبر الحدود. */
  function autoRatioScore(c, computedMetrics) {
    if (c.tiers) {
      const v = computedMetrics ? computedMetrics.revisionRoundsScore : null;
      return v === null || v === undefined ? null : v;
    }
    return scoreFromBand(computedMetrics ? computedMetrics[c.metric] : null, c.bands, c.higherIsBetter);
  }

  /** ركيزة تحتوي معايير من نوع ratio (تُحسب تلقائيًا) و/أو rubric (يدوي). */
  function computeRatioPillar(pillar, computedMetrics, criteriaScores) {
    const totalWeight = pillar.criteria.reduce((s, c) => s + (c.weight || 0), 0) || 100;
    let sum = 0;
    let complete = true;
    const resolved = {};
    for (const c of pillar.criteria) {
      let score;
      if (c.type === "ratio") {
        score = criteriaScores[c.id] !== undefined && criteriaScores[c.id] !== null && criteriaScores[c.id] !== ""
          ? Number(criteriaScores[c.id]) // override يدوي إن وُجد
          : autoRatioScore(c, computedMetrics);
      } else {
        score = criteriaScores[c.id];
      }
      resolved[c.id] = score;
      if (score === undefined || score === null || score === "" || !Number.isFinite(Number(score)) || Number(score) < 1 || Number(score) > 5) {
        complete = false;
        continue;
      }
      sum += (Number(score) * (c.weight || 0)) / totalWeight;
    }
    return { pillarScore: complete ? sum : null, resolved };
  }

  function classify(totalScore, classificationBands) {
    if (totalScore === null || totalScore === undefined) return null;
    const band = classificationBands.find((b) => totalScore >= b.min && totalScore <= b.max);
    return band ? band.label : null;
  }

  /**
   * الدالة الرئيسية: تحسب كل الركائز + الإجمالي بناءً على مسودة تقييم كاملة.
   * workRowsForQuarter: الأعمال الخاضعة للتقييم. opts.allWorkRows: كل أعمال الربع (لمؤشرات الانضباط).
   * ركيزة allowNotApplicable المعلَّمة notApplicable تُستبعد ويتوزّع وزنها على بقية الركائز لهذا الموظف.
   */
  function computeFullEvaluation(settings, employee, pillarScoresInput, workRowsForQuarter, opts) {
    opts = opts || {};
    const level = employee.level === "senior" ? "senior" : "writer";
    const weightKey = level === "senior" ? "weightSenior" : "weightWriter";
    const metrics = computeMetrics(workRowsForQuarter, {
      allRows: opts.allWorkRows || workRowsForQuarter,
      revisionCriterion: findTieredRevisionCriterion(settings),
    });
    const result = { pillars: {}, totalScore: null, classification: null, metrics };

    let applicableWeightSum = 0;
    let weightedSum = 0;
    let allComplete = true;

    for (const pillar of settings.pillars) {
      const pWeight = pillar[weightKey] || 0;
      if (pWeight === 0) {
        // ركيزة لا تنطبق على هذا المستوى إطلاقًا (كالقيادة بالنسبة لكاتب عادي) — تُستبعد كليًا من الاكتمال والاحتساب
        result.pillars[pillar.id] = { pillarScore: null, weight: 0 };
        continue;
      }
      const input = pillarScoresInput[pillar.id] || {};
      if (pillarNotYetIntroduced(pillar, opts.quarter)) {
        result.pillars[pillar.id] = { pillarScore: null, weight: pWeight, notApplicable: true, notIntroduced: true };
        continue;
      }
      if (pillar.allowNotApplicable && input.notApplicable) {
        result.pillars[pillar.id] = { pillarScore: null, weight: pWeight, notApplicable: true };
        continue;
      }
      applicableWeightSum += pWeight;
      let pillarResult;
      if (pillar.id === "quality") {
        pillarResult = computeQualityPillar(
          pillar,
          input.perSample || {},
          input.sampleWorkIds || [],
          employee.specialty,
          workRowsForQuarter,
          settings.revisionValueMultiplier
        );
      } else if (pillar.criteria.some((c) => c.type === "ratio")) {
        pillarResult = computeRatioPillar(pillar, metrics, input.criteriaScores || {});
      } else {
        pillarResult = computeFlatPillar(pillar, input.criteriaScores || {}, level);
      }
      result.pillars[pillar.id] = { ...pillarResult, weight: pWeight, notApplicable: false };
      if (pillarResult.pillarScore === null) {
        allComplete = false;
      } else {
        weightedSum += pillarResult.pillarScore * pWeight;
      }
    }

    if (allComplete && applicableWeightSum > 0) {
      // عند اكتمال الأوزان (100%) دون استبعاد، القسمة على المجموع = القسمة على 100 كما كانت سابقًا
      result.totalScore = Math.round((weightedSum / applicableWeightSum) * 100) / 100;
      result.classification = classify(result.totalScore, settings.classification);
    }
    return result;
  }

  /**
   * يعيد حساب تقييم محفوظ بالإعدادات الحالية، بنفس منطق شاشة التقييم تمامًا (دون أي تدخل يدوي):
   * الأعمال الخاضعة للتقييم = أعمال الربع ناقص المستثناة، ومعايير ratio تلقائية ما لم يعدّلها المقيّم يدويًا.
   * يعيد { pillarScores, totalScore, classification } بالشكل الذي يُخزَّن.
   */
  function recomputeStoredEvaluation(settings, employee, storedPillarScores, workRows, quarter) {
    const level = employee.level === "senior" ? "senior" : "writer";
    const weightKey = level === "senior" ? "weightSenior" : "weightWriter";
    const input = storedPillarScores ? JSON.parse(JSON.stringify(storedPillarScores)) : {};
    input.quality = input.quality || { sampleWorkIds: [], perSample: {} };
    input.quality.perSample = input.quality.perSample || {};
    const excluded = new Set(input.quality.excludedWorkIds || []);
    const rows = Array.isArray(workRows) ? workRows : [];
    const evaluable = rows.filter((w) => !excluded.has(w.id));
    input.quality.sampleWorkIds = evaluable.map((w) => w.id);
    for (const p of settings.pillars) {
      if (p.id === "quality" || !input[p.id]) continue;
      const scores = input[p.id].criteriaScores || {};
      const overrides = input[p.id].criteriaOverrides || {};
      (p.criteria || []).forEach((c) => {
        if (c.type === "ratio" && !overrides[c.id]) scores[c.id] = null;
      });
      input[p.id].criteriaScores = scores;
    }
    const full = computeFullEvaluation(settings, employee, input, evaluable, { allWorkRows: rows, quarter });
    const pillarScores = {};
    for (const p of settings.pillars) {
      if ((p[weightKey] || 0) === 0) continue;
      pillarScores[p.id] = { ...(input[p.id] || {}), ...(full.pillars[p.id] || {}) };
    }
    return { pillarScores, totalScore: full.totalScore, classification: full.classification };
  }

  /** اقتراح حدود تلقائي لمعيار ratio بناءً على متوسط أداء الفريق الفعلي. */
  function suggestBands(values, higherIsBetter) {
    const clean = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
    if (!clean.length) return null;
    const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
    const spread = Math.max(avg * 0.15, 1);
    if (higherIsBetter) {
      return { "5": Math.round((avg + spread) * 10) / 10, "3": Math.round(avg * 10) / 10, "1": Math.round(Math.max(0, avg - spread * 1.5) * 10) / 10 };
    }
    return { "5": Math.round(Math.max(0, avg - spread) * 10) / 10, "3": Math.round(avg * 10) / 10, "1": Math.round((avg + spread * 1.5) * 10) / 10 };
  }

  return {
    scoreFromBand,
    computeMetrics,
    isReviewWork,
    recomputeStoredEvaluation,
    pillarIntroducedQuarter,
    pillarNotYetIntroduced,
    revisionTierScore,
    findTieredRevisionCriterion,
    autoRatioScore,
    creativeMix,
    effectiveQualityWeights,
    computeQualityPillar,
    computeFlatPillar,
    computeRatioPillar,
    classify,
    computeFullEvaluation,
    suggestBands,
  };
})();

if (typeof module !== "undefined") module.exports = Calc;
