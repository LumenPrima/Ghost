import createKnex, { type Knex } from 'knex';

// A hand-made copy of the columns these tests touch, with the same unique key and
// foreign keys (and cascades) as schema.js.
export async function createProgressTables(knex: Knex): Promise<void> {
  await knex.schema.createTable('members', (table) => {
    table.string('id', 24).primary();
  });
  await knex.schema.createTable('posts', (table) => {
    table.string('id', 24).primary();
    table.string('type', 50).notNullable().defaultTo('post');
    table.string('status', 50).notNullable().defaultTo('draft');
    table.string('visibility', 50).notNullable().defaultTo('public');
  });
  await knex.schema.createTable('tags', (table) => {
    table.string('id', 24).primary();
    table.string('slug', 191).notNullable().unique();
  });
  await knex.schema.createTable('posts_tags', (table) => {
    table.string('id', 24).primary();
    table.string('post_id', 24).notNullable().references('posts.id');
    table.string('tag_id', 24).notNullable().references('tags.id');
    table.integer('sort_order').unsigned().notNullable().defaultTo(0);
  });
  await knex.schema.createTable('products', (table) => {
    table.string('id', 24).primary();
    table.string('slug', 191).notNullable().unique();
    table.string('type', 50).notNullable().defaultTo('paid');
  });
  await knex.schema.createTable('posts_products', (table) => {
    table.string('id', 24).primary();
    table.string('post_id', 24).notNullable().references('posts.id').onDelete('CASCADE');
    table.string('product_id', 24).notNullable().references('products.id').onDelete('CASCADE');
    table.integer('sort_order').unsigned().notNullable().defaultTo(0);
  });
  await knex.schema.createTable('members_post_progress', (table) => {
    table.string('id', 24).primary();
    table.string('member_id', 24).notNullable().references('members.id').onDelete('CASCADE');
    table.string('post_id', 24).notNullable().references('posts.id').onDelete('CASCADE');
    table.string('status', 50).notNullable();
    table.dateTime('created_at').notNullable();
    table.dateTime('updated_at').nullable();
    table.unique(['member_id', 'post_id']);
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
