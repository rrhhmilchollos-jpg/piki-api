import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_CATALOG_RESTAURANT_FILTER, CUSTOMER_ORDERABLE_RESTAURANT_FILTER, COMING_SOON_SLUGS, presentCustomerCatalogRestaurant } from './customerCatalogPolicy.js';

test('los partners próximos son visibles pero no son operables ni indexables como catálogo activo', () => {
  assert.equal(COMING_SOON_SLUGS.length, 4);
  const upcomingFilter = CUSTOMER_CATALOG_RESTAURANT_FILTER.$or[1] as { slug: { $in: readonly string[] } };
  assert.deepEqual(upcomingFilter.slug.$in, [...COMING_SOON_SLUGS]);
  assert.equal(CUSTOMER_ORDERABLE_RESTAURANT_FILTER.availabilityStatus, 'available');
  assert.deepEqual(CUSTOMER_ORDERABLE_RESTAURANT_FILTER['menu.0'], { $exists: true });
  for (const slug of COMING_SOON_SLUGS) {
    const view = presentCustomerCatalogRestaurant({name: slug, slug, availabilityStatus:'coming_soon', isActive: false, onboardingStatus: 'approved'});
    assert.equal(view.orderable, false);
    assert.equal(view.availabilityLabel, 'Disponible muy pronto');
  }
});

test('un restaurante aprobado, activo y disponible se presenta como operable', () => {
  const view = presentCustomerCatalogRestaurant({ name: 'Restaurante local', slug: 'restaurante-local', availabilityStatus: 'available', isActive: true, onboardingStatus: 'approved' });
  assert.equal(view.orderable, true);
  assert.equal(view.comingSoon, false);
});
