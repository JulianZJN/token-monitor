'use strict';

const {
  normalizeModelAliases,
  inferModelAliases,
  createModelAliasResolver
} = require('./renderer/modelAliases');
const { historyRevision, num } = require('../shared/history');

const MODEL_MAP_FIELDS = [
  'models',
  'modelCosts',
  'modelCacheReads',
  'modelCacheWrites',
  'modelOutputs',
  'modelUnclassifiedTokens'
];

function mapValues(value, project) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, project(row)]));
}

function addModelId(target, value) {
  if (typeof value !== 'string') return;
  const model = value.trim();
  if (model) target.add(model);
}

function addModelMapIds(target, value) {
  if (!value || typeof value !== 'object') return;
  for (const model of Object.keys(value)) addModelId(target, model);
}

function addClientModelIds(target, value) {
  if (!value || typeof value !== 'object') return;
  for (const models of Object.values(value)) addModelMapIds(target, models);
}

function collectUsageModelIds(value, target = new Set()) {
  if (!value || typeof value !== 'object') return target;
  addModelId(target, value.model);
  for (const field of MODEL_MAP_FIELDS) addModelMapIds(target, value[field]);
  for (const field of ['clientModels', 'clientModelCosts']) addClientModelIds(target, value[field]);
  for (const field of ['sessions', 'projects']) {
    for (const row of Object.values(value[field] || {})) collectUsageModelIds(row, target);
  }
  return target;
}

function collectHistoryModelIds(history, target = new Set()) {
  if (!history || typeof history !== 'object') return target;
  for (const field of ['daily', 'monthly']) {
    for (const row of Array.isArray(history[field]) ? history[field] : []) {
      addModelMapIds(target, row?.perModel);
      addClientModelIds(target, row?.clientModelCosts);
    }
  }
  addModelId(target, history.summary?.favoriteModel);
  addClientModelIds(target, history.summary?.clientModelCosts);
  for (const device of Array.isArray(history.deviceHistories) ? history.deviceHistories : []) {
    for (const period of Object.values(device?.periods || {})) collectUsageModelIds(period, target);
    collectHistoryModelIds(device?.history, target);
  }
  return target;
}

function collectStatsModelIds(stats) {
  const target = new Set();
  if (!stats || typeof stats !== 'object') return target;
  for (const period of Object.values(stats.periods || {})) collectUsageModelIds(period, target);
  for (const field of ['today', 'month', 'allTime']) collectUsageModelIds(stats[field], target);
  for (const device of Array.isArray(stats.devices) ? stats.devices : []) {
    for (const period of Object.values(device?.periods || {})) collectUsageModelIds(period, target);
    for (const field of ['today', 'month', 'allTime']) collectUsageModelIds(device?.[field], target);
    collectHistoryModelIds(device?.history, target);
    collectHistoryModelIds(device?.historyPreview, target);
  }
  for (const row of Object.values(stats.allTimeSessionsView || {})) collectUsageModelIds(row, target);
  for (const field of ['nativeSessions', 'nativeProjects']) {
    for (const period of Object.values(stats[field] || {})) {
      for (const row of Object.values(period || {})) collectUsageModelIds(row, target);
    }
  }
  collectHistoryModelIds(stats.history, target);
  collectHistoryModelIds(stats.historyPreview, target);
  return target;
}

function foldModelMap(value, resolve) {
  const result = new Map();
  for (const [model, amount] of Object.entries(value || {})) {
    const key = resolve(model);
    result.set(key, (result.get(key) || 0) + num(amount));
  }
  return Object.fromEntries(result);
}

function projectUsage(value, resolve) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  if (typeof value.model === 'string') result.model = resolve(value.model);
  for (const field of MODEL_MAP_FIELDS) {
    if (value[field]) result[field] = foldModelMap(value[field], resolve);
  }
  for (const field of ['clientModels', 'clientModelCosts']) {
    if (value[field]) result[field] = mapValues(value[field], (row) => foldModelMap(row, resolve));
  }
  for (const field of ['sessions', 'projects']) {
    if (value[field]) result[field] = mapValues(value[field], (row) => projectUsage(row, resolve));
  }
  return result;
}

function unclassifiedTokens(bucket) {
  if (Object.hasOwn(bucket || {}, 'unclassifiedTokens')) return num(bucket.unclassifiedTokens);
  return bucket?.tokenComponentsAvailable === true ? 0 : num(bucket?.tokens);
}

function mergeHistoryModel(previous, bucket) {
  const merged = { ...previous };
  for (const [field, value] of Object.entries(bucket || {})) {
    if (typeof value === 'number') merged[field] = num(previous?.[field]) + num(value);
    else if (field === 'tokenComponentsAvailable') {
      merged[field] = value === true && previous?.[field] !== false;
    } else if (!Object.hasOwn(merged, field)) {
      merged[field] = value;
    }
  }
  if (previous) {
    merged.unclassifiedTokens = unclassifiedTokens(previous) + unclassifiedTokens(bucket);
  }
  return merged;
}

function projectHistoryRow(row, resolve) {
  if (!row || typeof row !== 'object') return row;
  const result = { ...row };
  if (row.perModel) {
    const grouped = new Map();
    for (const [model, bucket] of Object.entries(row.perModel)) {
      const key = resolve(model);
      grouped.set(key, mergeHistoryModel(grouped.get(key), bucket));
    }
    result.perModel = Object.fromEntries(grouped);
  }
  if (row.clientModelCosts) {
    result.clientModelCosts = mapValues(row.clientModelCosts, (models) => foldModelMap(models, resolve));
  }
  return result;
}

function favoriteModel(models) {
  let favorite = '';
  let mostTokens = -1;
  for (const [model, tokens] of Object.entries(models || {})) {
    const value = num(tokens);
    if (value > mostTokens) {
      favorite = model;
      mostTokens = value;
    }
  }
  return favorite;
}

function projectHistory(history, resolve, fallbackModels) {
  if (!history || typeof history !== 'object') return history;
  const result = { ...history };
  for (const field of ['daily', 'monthly']) {
    if (Array.isArray(history[field])) result[field] = history[field].map((row) => projectHistoryRow(row, resolve));
  }

  if (history.summary) {
    const summary = { ...history.summary };
    if (typeof summary.favoriteModel === 'string') summary.favoriteModel = resolve(summary.favoriteModel);
    if (summary.clientModelCosts) {
      summary.clientModelCosts = mapValues(summary.clientModelCosts, (models) => foldModelMap(models, resolve));
    }

    const totals = new Map();
    for (const row of result.monthly || []) {
      for (const [model, bucket] of Object.entries(row.perModel || {})) {
        totals.set(model, (totals.get(model) || 0) + num(bucket.tokens));
      }
    }
    let models = Object.fromEntries(totals);
    if (Object.keys(models).length === 0 && fallbackModels) models = foldModelMap(fallbackModels, resolve);
    const representedTokens = Object.values(models).reduce((sum, value) => sum + num(value), 0);
    if (num(history.summary.totalTokens) > 0 && representedTokens === num(history.summary.totalTokens)) {
      summary.favoriteModel = favoriteModel(models);
    }
    result.summary = summary;
  }

  if (Array.isArray(history.deviceHistories)) {
    result.deviceHistories = history.deviceHistories.map((device) => ({
      ...device,
      ...(device.periods ? { periods: mapValues(device.periods, (period) => projectUsage(period, resolve)) } : {}),
      history: projectHistory(device.history, resolve)
    }));
  }
  return result;
}

function aliasPlan(modelIds, aliases) {
  const explicit = normalizeModelAliases(aliases);
  const automatic = inferModelAliases(modelIds);
  return {
    explicit,
    automatic,
    active: Object.keys(explicit).length > 0 || Object.keys(automatic).length > 0,
    resolve: createModelAliasResolver(explicit, modelIds)
  };
}

function projectModelAliasHistory(history, aliases) {
  if (!history || typeof history !== 'object') return history;
  const modelIds = [...collectHistoryModelIds(history)];
  const plan = aliasPlan(modelIds, aliases);
  return plan.active ? projectHistory(history, plan.resolve) : history;
}

function projectModelAliasStats(stats, aliases) {
  if (!stats || typeof stats !== 'object') return stats;
  const sourceIds = [...collectStatsModelIds(stats)];
  const plan = aliasPlan(sourceIds, aliases);
  if (!plan.active) return stats;

  const projectRecord = (record) => {
    const result = { ...record };
    if (record.periods) result.periods = mapValues(record.periods, (period) => projectUsage(period, plan.resolve));
    for (const field of ['today', 'month', 'allTime']) {
      if (record[field]) result[field] = projectUsage(record[field], plan.resolve);
    }
    for (const field of ['history', 'historyPreview']) {
      if (record[field]) {
        result[field] = projectHistory(
          record[field],
          plan.resolve,
          record.periods?.allTime?.models || record.allTime?.models
        );
      }
    }
    return result;
  };

  const result = projectRecord(stats);
  const pricingSourceIds = new Set();
  for (const period of ['today', 'month', 'allTime']) {
    addModelMapIds(pricingSourceIds, stats.periods?.[period]?.models);
    addModelMapIds(pricingSourceIds, stats[period]?.models);
  }
  result.modelAliasSourceIds = [...pricingSourceIds].sort();

  if (Array.isArray(stats.devices)) result.devices = stats.devices.map(projectRecord);
  if (stats.allTimeSessionsView) {
    result.allTimeSessionsView = mapValues(stats.allTimeSessionsView, (session) => projectUsage(session, plan.resolve));
  }
  for (const field of ['nativeSessions', 'nativeProjects']) {
    if (stats[field]) {
      result[field] = mapValues(stats[field], (period) => mapValues(period, (row) => projectUsage(row, plan.resolve)));
    }
  }

  const revision = historyRevision({
    summary: {
      modelAliases: plan.explicit,
      automaticModelAliases: plan.automatic
    }
  });
  for (const field of ['historyRevision', 'deviceHistoryRevision']) {
    result[field] = `${stats[field] || ''}:aliases:${revision}`;
  }
  return result;
}

module.exports = {
  normalizeModelAliases,
  inferModelAliases,
  createModelAliasResolver,
  projectModelAliasStats,
  projectModelAliasHistory
};
