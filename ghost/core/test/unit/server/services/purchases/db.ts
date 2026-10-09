import createKnex, { type Knex } from 'knex';

// A hand-made copy of the members_purchases columns that matter here, with the
// same unique keys and foreign keys as schema.js.
export async function createPurchaseTables(knex: Knex): Promise<void> {
  await knex.schema.createTable('members', (table) => {
    table.string('id', 24).primary();
  });
  await knex.schema.createTable('products', (table) => {
    table.string('id', 24).primary();
  });
  await knex.schema.createTable('members_purchases', (table) => {
    table.string('id', 24).primary();
    table.string('member_id', 24).nullable().references('members.id').onDelete('SET NULL');
    table.string('product_id', 24).notNullable().references('products.id');
    table.string('stripe_checkout_session_id', 255).nullable().unique();
    table.string('stripe_payment_intent_id', 255).nullable().unique();
    table.string('stripe_customer_id', 255).nullable();
    table.integer('amount').unsigned().notNullable();
    table.string('currency', 50).notNullable();
    table.string('status', 50).notNullable().defaultTo('paid');
    table.dateTime('expires_at').nullable();
    table.dateTime('refunded_at').nullable();
    table.string('attribution_id', 24).nullable();
    table.string('attribution_type', 50).nullable();
    table.string('attribution_url', 2000).nullable();
    table.string('referrer_source', 191).nullable();
    table.string('referrer_medium', 191).nullable();
    table.string('referrer_url', 2000).nullable();
    table.string('utm_source', 191).nullable();
    table.string('utm_medium', 191).nullable();
    table.string('utm_campaign', 191).nullable();
    table.string('utm_term', 191).nullable();
    table.string('utm_content', 191).nullable();
    table.dateTime('created_at').notNullable();
    table.dateTime('updated_at').nullable();
    table.index(['member_id', 'product_id']);
  });
}

export function createSqliteKnex(): Knex {
  return createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(connection: { pragma(sql: string): void }, done: (err?: Error) => void) {
        connection.pragma('foreign_keys = ON');
        done();
      },
    },
  });
}
