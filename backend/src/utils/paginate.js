import mongoose from 'mongoose';
import { escapeRegex } from './http.js';

export async function paginate(model, baseFilter, query, opts = {}) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '10'), 10) || 10));

  const filter = { ...baseFilter };
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search && opts.searchFields && opts.searchFields.length) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const or = opts.searchFields.map((f) => ({ [f]: rx }));
    filter.$and = [...(filter.$and || []), { $or: or }];
  }

  let sort = {};
  const rawSort = typeof query.sort === 'string' ? query.sort : opts.defaultSort || '-createdAt';
  const field = rawSort.replace(/^-/, '');
  const allowed = opts.sortable || [];
  if (allowed.includes(field) || field === 'createdAt') {
    sort[field] = rawSort.startsWith('-') ? -1 : 1;
  } else {
    const d = opts.defaultSort || '-createdAt';
    sort[d.replace(/^-/, '')] = d.startsWith('-') ? -1 : 1;
  }

  let q = model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit);
  for (const p of opts.populate || []) q = q.populate(p);
  const [items, total] = await Promise.all([q.lean().exec(), model.countDocuments(filter)]);
  return { items, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
}
