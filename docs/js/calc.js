// محرك الاحتساب — نظام «متم». دوال خالصة (pure) قابلة للاختبار بمعزل عن الواجهة.
// يعتمد كليًا على إعدادات المعايير القادمة من الخادم (Settings) — لا أرقام ثابتة هنا.

const Calc = (() => {
  /** يحوّل قيمة مقياس (نسبة/عدد) إلى درجة 1-5 متصلة بناءً على نقاط الارتكاز 5/3/1. */
  function scoreFromBand(value, bands, higherIsBetter) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    const b5 = bands["5"], b3 = bands["3"], b1 = bands["1"];
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

  /** يحسب مقاييس ركيزة "رضا العميل" و"الانضباط" من سجل الأعمال الفعلي لموظف/ربع معيّن. */
  function computeMetrics(workRows) {
    const delivered = workRows.filter((w) => w.delivered);
    const total = workRows.length;
    const firstDraftAcceptRate = delivered.length
      ? (100 * delivered.filter((w) => w.firstDraftAccepted).length) / delivered.length
      : null;
    const avgContentRevisionRounds = delivered.length
      ? delivered.reduce((s, w) => s + (Number(w.contentRevisionRounds) || 0), 0) / delivered.length
      : null;
    const onTimeRate = delivered.length
      ? (100 * delivered.filter((w) => w.onTime).length) / delivered.length
      : null;
    const taskCompletionRate = total ? (100 * delivered.length) / total : null;
    return { firstDraftAcceptRate, avgContentRevisionRounds, onTimeRate, taskCompletionRate };
  }

  /** نسبة مزيج الإبداعي/الرسمي هذا الربع — يُستخدم لتحديد أوزان معايير الجودة لكاتب "عام". */
  function creativeMix(workRows) {
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

  /** يحسب درجة ركيزة الجودة من درجات العينة (متوسط كل معيار عبر الأعمال المختارة). */
  function computeQualityPillar(qualityPillar, perSample, sampleWorkIds, specialty, workRowsForMix, revisionMultiplier) {
    const weights = effectiveQualityWeights(qualityPillar, specialty, workRowsForMix);
    const mult = revisionMultiplier === undefined || revisionMultiplier === null ? 1 : revisionMultiplier;
    const weightOfSample = (wid) => {
      const w = (workRowsForMix || []).find((r) => r.id === wid);
      return w && w.isRevision ? mult : 1;
    };
    const criteriaAvg = {};
    for (const c of qualityPillar.criteria) {
      // متوسط مرجّح: عينات "مراجعة لعمل سابق" تُحتسب بقيمة مخفَّضة بدل قيمة كاملة مكررة
      let weightedSum = 0;
      let weightSum = 0;
      sampleWorkIds.forEach((wid) => {
        const v = perSample?.[wid]?.[c.id];
        if (v === undefined || v === null || v === "") return;
        const w = weightOfSample(wid);
        weightedSum += Number(v) * w;
        weightSum += w;
      });
      criteriaAvg[c.id] = weightSum > 0 ? weightedSum / weightSum : null;
    }
    let pillarScore = null;
    const complete = qualityPillar.criteria.every((c) => criteriaAvg[c.id] !== null);
    if (complete) {
      pillarScore = qualityPillar.criteria.reduce(
        (sum, c) => sum + (criteriaAvg[c.id] * weights[c.id]) / 100,
        0
      );
    }
    return { criteriaAvg, weights, pillarScore };
  }

  /** ركيزة مؤشرات مباشرة (تفاعل / انضباط الشق الرقابي / نمو) — درجات يدوية بأوزان معيار لكل معيار. */
  function computeFlatPillar(pillar, criteriaScores, level) {
    const applicable = pillar.criteria.filter((c) => !c.appliesToLevel || c.appliesToLevel === level);
    const totalWeight = applicable.reduce((s, c) => s + (c.weight || 0), 0) || 100;
    let sum = 0;
    let complete = true;
    for (const c of applicable) {
      const v = criteriaScores[c.id];
      if (v === undefined || v === null || v === "") {
        complete = false;
        continue;
      }
      sum += (Number(v) * (c.weight || 0)) / totalWeight;
    }
    return { pillarScore: complete ? sum : null };
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
        const metricValue = computedMetrics[c.metric];
        score = criteriaScores[c.id] !== undefined && criteriaScores[c.id] !== null && criteriaScores[c.id] !== ""
          ? Number(criteriaScores[c.id]) // override يدوي إن وُجد
          : scoreFromBand(metricValue, c.bands, c.higherIsBetter);
      } else {
        score = criteriaScores[c.id];
      }
      resolved[c.id] = score;
      if (score === undefined || score === null || Number.isNaN(score)) {
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

  /** الدالة الرئيسية: تحسب كل الركائز + الإجمالي بناءً على مسودة تقييم كاملة. */
  function computeFullEvaluation(settings, employee, pillarScoresInput, workRowsForQuarter) {
    const level = employee.level === "senior" ? "senior" : "writer";
    const weightKey = level === "senior" ? "weightSenior" : "weightWriter";
    const metrics = computeMetrics(workRowsForQuarter);
    const result = { pillars: {}, totalScore: null, classification: null, metrics };

    let totalWeightSum = 0;
    let weightedSum = 0;
    let allComplete = true;

    for (const pillar of settings.pillars) {
      const pWeight = pillar[weightKey] || 0;
      totalWeightSum += pWeight;
      if (pWeight === 0) {
        // ركيزة لا تنطبق على هذا المستوى إطلاقًا (كالقيادة بالنسبة لكاتب عادي) — تُستبعد كليًا من الاكتمال والاحتساب
        result.pillars[pillar.id] = { pillarScore: null, weight: 0 };
        continue;
      }
      let pillarResult;
      if (pillar.id === "quality") {
        const input = pillarScoresInput.quality || {};
        pillarResult = computeQualityPillar(
          pillar,
          input.perSample || {},
          input.sampleWorkIds || [],
          employee.specialty,
          workRowsForQuarter,
          settings.revisionValueMultiplier
        );
      } else if (pillar.criteria.some((c) => c.type === "ratio")) {
        const input = pillarScoresInput[pillar.id] || {};
        pillarResult = computeRatioPillar(pillar, metrics, input.criteriaScores || {});
      } else {
        const input = pillarScoresInput[pillar.id] || {};
        pillarResult = computeFlatPillar(pillar, input.criteriaScores || {}, level);
      }
      result.pillars[pillar.id] = { ...pillarResult, weight: pWeight };
      if (pillarResult.pillarScore === null) {
        allComplete = false;
      } else {
        weightedSum += (pillarResult.pillarScore * pWeight) / 100;
      }
    }

    if (allComplete) {
      result.totalScore = Math.round(weightedSum * 100) / 100;
      result.classification = classify(result.totalScore, settings.classification);
    }
    return result;
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
