// ✅ نسخة مصححة من calc.js مع حماية من أخطاء الحسابات

/**
 * حساب الدرجة من خرائط الأفقية (Bands)
 * مع حماية من divide-by-zero
 */
function scoreFromBand(value, band) {
  if (!band || band.length < 6) return null;

  // ✅ إضافة حماية: التحقق من أن الخرائط ليست متساوية
  const b5 = band[5];
  const b3 = band[3];
  const b1 = band[1];

  // حماية من divide-by-zero
  if (b5 === b3 || b3 === b1) {
    console.warn("⚠️ تحذير: خرائط الأفقية متساوية (b5 == b3 أو b3 == b1)");
    console.warn(`   b1=${b1}, b3=${b3}, b5=${b5}`);
    return null; // أعد null بدل NaN
  }

  if (value >= b5) return 5;
  if (value >= b3) {
    // interpolate between b3-b5 → score 3-5
    const score = 3 + 2 * (value - b3) / (b5 - b3);
    return Math.min(5, score);
  }
  if (value >= b1) {
    // interpolate between b1-b3 → score 1-3
    const score = 1 + 2 * (value - b1) / (b3 - b1);
    return Math.min(3, score);
  }

  return 1;
}

/**
 * حساب المقاييس الأساسية
 */
function computeMetrics(work, settings) {
  if (!work || !settings) return null;

  const metrics = {};

  // كل pillar له معايير مختلفة
  settings.pillars.forEach(p => {
    const pillarKey = p.id;
    metrics[pillarKey] = {};

    p.criteria.forEach(crit => {
      const critKey = crit.id;
      const value = work.criteria[critKey];

      // احصل على الخريطة الأفقية (band) للمعيار
      const band = settings.bands[critKey];

      if (band && value !== null && value !== undefined) {
        metrics[pillarKey][critKey] = scoreFromBand(value, band);
      }
    });
  });

  return metrics;
}

/**
 * Creative Mix — مزج الدرجات بطريقة ذكية
 */
function creativeMix(scores) {
  if (!scores || scores.length === 0) return null;

  // تصفية القيم الصحيحة
  const valid = scores.filter(s => s !== null && s !== undefined && !isNaN(s));
  if (valid.length === 0) return null;

  // المتوسط الحسابي
  return valid.reduce((a, b) => a + b) / valid.length;
}

/**
 * حساب أوزان الجودة الفعّالة
 */
function effectiveQualityWeights(qualityPillar, settings) {
  if (!qualityPillar || !settings) return null;

  const { weights } = qualityPillar;
  if (!weights) return null;

  // إعادة توازن الأوزان
  const total = Object.values(weights).reduce((a, b) => (a || 0) + (b || 0), 0);
  if (total === 0) return null;

  const normalized = {};
  Object.keys(weights).forEach(key => {
    normalized[key] = (weights[key] || 0) / total;
  });

  return normalized;
}

/**
 * حساب الركيزة (Pillar) — Quality
 */
function computeQualityPillar(work, settings, allMetrics) {
  if (!work || !settings || !allMetrics) return null;

  const pillarId = "quality";
  const scores = allMetrics[pillarId];

  if (!scores || Object.keys(scores).length === 0) {
    return { score: null, reason: "لا توجد معايير للجودة" };
  }

  const scoreArray = Object.values(scores).filter(s => s !== null);
  if (scoreArray.length === 0) return { score: null, reason: "جميع معايير الجودة فارغة" };

  const score = creativeMix(scoreArray);
  return { score, componentScores: scores };
}

/**
 * حساب الركيزة — Flat (مسطحة)
 */
function computeFlatPillar(work, settings, allMetrics) {
  if (!work || !settings || !allMetrics) return null;

  // تجميع جميع الدرجات من جميع المعايير
  const allScores = [];
  Object.values(allMetrics).forEach(pillarScores => {
    if (pillarScores && typeof pillarScores === 'object') {
      const scores = Object.values(pillarScores).filter(s => s !== null);
      allScores.push(...scores);
    }
  });

  if (allScores.length === 0) return { score: null, reason: "لا توجد درجات" };

  const score = creativeMix(allScores);
  return { score };
}

/**
 * حساب الركيزة — Ratio (نسبية)
 */
function computeRatioPillar(work, settings, allMetrics) {
  if (!work || !settings || !allMetrics) return null;

  const allScores = [];
  const allWeights = [];

  settings.pillars.forEach(p => {
    const pillarScores = allMetrics[p.id];
    if (pillarScores && typeof pillarScores === 'object') {
      Object.entries(pillarScores).forEach(([critId, score]) => {
        if (score !== null) {
          allScores.push(score);
          // ابحث عن وزن هذا المعيار
          const criterion = p.criteria.find(c => c.id === critId);
          if (criterion && criterion.weight) {
            allWeights.push(criterion.weight);
          }
        }
      });
    }
  });

  if (allScores.length === 0) return { score: null };

  // إذا لم توجد أوزان، استخدم المتوسط البسيط
  if (allWeights.length !== allScores.length) {
    return { score: creativeMix(allScores) };
  }

  // حساب المتوسط المرجح
  const weighted = allScores.reduce((sum, score, i) => sum + score * allWeights[i], 0);
  const totalWeight = allWeights.reduce((a, b) => a + b, 0);

  return { score: totalWeight > 0 ? weighted / totalWeight : null };
}

/**
 * تصنيف الدرجة إلى نطاق
 */
function classify(score) {
  if (score === null || score === undefined || isNaN(score)) return "غير مقيّم";
  if (score >= 4.5) return "ممتاز جداً";
  if (score >= 4) return "ممتاز";
  if (score >= 3.5) return "جيد جداً";
  if (score >= 3) return "جيد";
  if (score >= 2.5) return "متوسط";
  if (score >= 2) return "مقبول";
  return "ضعيف";
}

/**
 * حساب التقييم الكامل
 * ✅ مصحح: يعيد null إذا كانت أي ركيزة فارغة (هذا صحيح بالتصميم)
 */
function computeFullEvaluation(work, settings, evaluator) {
  if (!work || !settings) return null;

  // 1. احسب جميع المقاييس الأساسية
  const allMetrics = computeMetrics(work, settings);
  if (!allMetrics) return { error: "فشل حساب المقاييس" };

  // 2. احسب كل ركيزة
  const results = {};
  let allComplete = true;

  settings.pillars.forEach(p => {
    const pillarId = p.id;
    const scores = allMetrics[pillarId] || {};
    const scoreArray = Object.values(scores).filter(s => s !== null);

    if (scoreArray.length === 0) {
      results[pillarId] = null;
      allComplete = false;
    } else {
      results[pillarId] = creativeMix(scoreArray);
    }
  });

  // ✅ إذا كانت أي ركيزة بدون درجات، أعد null (هذا متعمد)
  if (!allComplete) {
    return { totalScore: null, pillars: results, reason: "بعض الركائز غير مكتملة" };
  }

  // 3. احسب الدرجة الكلية
  let totalScore = 0;
  let weightSum = 0;

  settings.pillars.forEach(p => {
    const score = results[p.id];
    const weight = p.weight || 0;
    if (score !== null) {
      totalScore += score * weight;
      weightSum += weight;
    }
  });

  // 4. تصحيح الوزن (يجب أن يساوي 100 أو 1)
  const totalWeight = settings.pillars.reduce((sum, p) => sum + (p.weight || 0), 0);
  if (totalWeight > 0) {
    totalScore = totalScore / totalWeight * 100;
  }

  return {
    totalScore: totalScore > 0 ? totalScore / 100 : null, // تحويل إلى نطاق 0-5
    pillars: results,
    classification: classify(totalScore / 100),
    allComplete: true
  };
}

// ✅ تصدير جميع الدوال
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scoreFromBand,
    computeMetrics,
    creativeMix,
    effectiveQualityWeights,
    computeQualityPillar,
    computeFlatPillar,
    computeRatioPillar,
    classify,
    computeFullEvaluation
  };
}
