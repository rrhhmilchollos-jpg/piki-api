type IndexDescription = { key?: Record<string, unknown>; unique?: boolean; sparse?: boolean; partialFilterExpression?: unknown };
type RestaurantIndexReader = { listIndexes(): { toArray(): Promise<IndexDescription[]> } };

/** Verify the slug uniqueness guard. Never creates, drops or syncs any index. */
export async function preflightRestaurantCatalogIndexes(collection: RestaurantIndexReader): Promise<void> {
  const indexes = await collection.listIndexes().toArray();
  const guarded = indexes.some((index) => index.unique === true && index.key?.slug === 1 && Object.keys(index.key).length === 1 && !index.sparse && !index.partialFilterExpression);
  if (!guarded) throw new Error("RESTAURANT_UNIQUE_SLUG_INDEX_REQUIRED: revisar el índice Restaurant en una operación de mantenimiento separada autorizada");
}
