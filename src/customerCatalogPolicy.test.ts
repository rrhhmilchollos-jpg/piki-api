import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_CATALOG_RESTAURANT_FILTER, CUSTOMER_ORDERABLE_RESTAURANT_FILTER, COMING_SOON_SLUGS, presentCustomerCatalogRestaurant, restaurantIsWithinOpeningHours } from './customerCatalogPolicy.js';

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

test('un horario partido permite pedidos en mañana y tarde-noche y los bloquea entre franjas', () => {
  const hours = { lunes: { morning: { open: '11:00', close: '14:00', closed: false }, evening: { open: '18:00', close: '23:00', closed: false }, closed: false } };
  assert.equal(restaurantIsWithinOpeningHours(hours, new Date('2026-10-19T10:00:00Z')), true);
  assert.equal(restaurantIsWithinOpeningHours(hours, new Date('2026-10-19T15:00:00Z')), false);
  assert.equal(restaurantIsWithinOpeningHours(hours, new Date('2026-10-19T19:00:00Z')), true);
});

test('Alibaba conserva el configurador cuando el registro legacy trae complementos vacíos', () => {
  const view = presentCustomerCatalogRestaurant({
    name: 'Alibaba Kebab Xàtiva',
    slug: 'alibaba-kebab-xativa',
    availabilityStatus: 'coming_soon',
    isActive: false,
    onboardingStatus: 'approved',
    menu: [{ id: 'alibaba-01', name: 'Menú 10', price: 10.5, modifiers: [], modifierGroups: [] }],
  });
  assert.equal(view.menu[0].modifierGroups.length, 1);
  assert.equal(view.menu[0].modifierGroups[0].options.length, 5);
  assert.equal(view.menu[0].modifierGroups[0].minSelections, 1);
});
