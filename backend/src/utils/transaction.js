import mongoose from 'mongoose';

let transactionSupport;

async function supportsTransactions() {
  if (transactionSupport !== undefined) return transactionSupport;
  const db = mongoose.connection.db;
  if (!db) {
    transactionSupport = false;
    return transactionSupport;
  }
  try {
    const hello = await db.admin().command({ hello: 1 });
    transactionSupport = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    transactionSupport = false;
  }
  return transactionSupport;
}

export async function runInTransaction(work) {
  const session = await mongoose.startSession();
  try {
    if (!(await supportsTransactions())) return await work(session);

    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
