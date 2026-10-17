export const ALIBABA_KEBAB_COVER_IMAGE = "https://images.unsplash.com/photo-1561651823-34feb02250e4?auto=format&fit=crop&w=1280&q=80";

const drinkOptions = [
  { id: "coca-cola", name: "Coca-Cola Original lata 330 ml", price: 0 },
  { id: "coca-cola-zero", name: "Coca-Cola Zero lata 330 ml", price: 0 },
  { id: "fanta-naranja", name: "Fanta Naranja lata 330 ml", price: 0 },
  { id: "fanta-limon", name: "Fanta Limón lata 330 ml", price: 0 },
  { id: "nestea-limon", name: "Nestea Té Negro Limón lata 330 ml", price: 0 },
  { id: "aquarius-limon", name: "Aquarius Limón lata 330 ml", price: 0 },
  { id: "aquarius-naranja", name: "Aquarius Naranja lata 330 ml", price: 0 },
  { id: "agua-1500", name: "Agua 1,5 l", price: 0 },
];

const sauceOptions = [
  { id: "salsa-yogur", name: "Salsa de yogur", price: 0 },
  { id: "salsa-picante", name: "Salsa picante", price: 0 },
  { id: "salsa-barbacoa", name: "Salsa barbacoa", price: 0 },
  { id: "sin-salsa", name: "Sin salsa", price: 0 },
];

const kebabModifiers = [
  { id: "salsa", name: "Elige tu salsa", description: "Opcional · elige una", price: 0, required: false, minSelections: 0, maxSelections: 1, options: sauceOptions },
  { id: "extra", name: "¿Quieres añadir un extra?", description: "Opcional · elige uno", price: 0, required: false, minSelections: 0, maxSelections: 1, options: [
    { id: "queso", name: "Extra de queso", price: 1 },
    { id: "carne", name: "Extra de carne", price: 2 },
    { id: "gratinado", name: "Extra gratinado", price: 1.9 },
  ] },
];

const menuModifiers = [
  { id: "bebida", name: "Elige tu bebida", description: "Incluida en el menú", price: 0, required: true, minSelections: 1, maxSelections: 1, options: drinkOptions },
  ...kebabModifiers,
];

const item = (id: string, name: string, price: number, category: string, description: string, modifiers: unknown[] = [], popular = false) => ({
  id,
  name,
  price,
  category,
  description,
  image: "",
  allergens: ["Gluten"],
  modifiers,
  available: true,
  vegetarian: false,
  popular,
});

export const alibabaKebabMenu = [
  item("alibaba-menu-10", "Menú 10", 10.5, "Menús", "Doner plato especial grande con ensalada, carne asada, patatas y bebida", menuModifiers, true),
  item("alibaba-menu-1", "Menú 1", 9, "Menús", "1 doner kebab, patatas fritas y 1 bebida", menuModifiers, true),
  item("alibaba-menu-5-grande", "Menú 5 (Grande)", 9, "Menús", "Patatas con carne", menuModifiers, true),
  item("alibaba-tapa-patatas-carne-grande", "Tapa de patatas con carne (Grande)", 9, "Tapas", "Patatas fritas cubiertas con carne asada", kebabModifiers),
  item("alibaba-tapa-patatas-carne-mediana", "Tapa de patatas con carne (Mediana)", 7, "Tapas", "Patatas fritas cubiertas con carne asada", kebabModifiers),
  item("alibaba-tapa-bravas", "Tapa de patatas bravas", 4.9, "Tapas", "Patatas con salsa brava", kebabModifiers),
  item("alibaba-tapa-deluxe", "Tapa de patatas deluxe", 4.9, "Tapas", "Patatas deluxe", kebabModifiers),
  item("alibaba-tapa-fritas", "Tapa de patatas fritas", 3, "Tapas", "Ración de patatas fritas", kebabModifiers),
  item("alibaba-doner-plato-especial", "Doner plato especias especial", 9, "Doner Kebab", "Ensalada, carne asada, patatas y bebida", menuModifiers, true),
  item("alibaba-doner-normal", "Doner normal", 6.5, "Doner Kebab", "Pan pita, lechuga, tomate, carne a elegir y salsas", kebabModifiers),
  item("alibaba-hamburguesa-pollo-menu", "Hamburguesa de pollo con patatas y bebida", 9, "Hamburguesas", "Hamburguesa de pollo, patatas y bebida", menuModifiers),
  item("alibaba-hamburguesa-pollo", "Hamburguesa de pollo", 5.5, "Hamburguesas", "Hamburguesa de pollo", kebabModifiers),
  item("alibaba-zumo-juver-melocoton", "Zumo Juver melocotón (200 ml)", 2.5, "Bebidas Sin Alcohol", "Zumo de melocotón", [], true),
  item("alibaba-agua-1500", "Agua (1,5 l)", 2.3, "Bebidas Sin Alcohol", "Agua mineral", []),
  item("alibaba-aquarius-limon", "Aquarius Limón lata 330 ml", 2.3, "Bebidas Sin Alcohol", "Refresco", []),
  item("alibaba-aquarius-naranja", "Aquarius Naranja lata 330 ml", 2.3, "Bebidas Sin Alcohol", "Refresco", []),
  item("alibaba-nestea-limon", "Nestea Té Negro Limón lata 330 ml", 2.3, "Bebidas Sin Alcohol", "Refresco", []),
  item("alibaba-coca-cola", "Coca-Cola Sabor Original lata 330 ml", 2.2, "Bebidas Sin Alcohol", "Refresco", []),
  item("alibaba-coca-cola-zero", "Coca-Cola Zero Azúcar lata 330 ml", 2.2, "Bebidas Sin Alcohol", "Refresco", []),
  item("alibaba-fanta-naranja", "Fanta Naranja lata 330 ml", 2.2, "Bebidas Sin Alcohol", "Refresco", []),
  item("alibaba-fanta-limon", "Fanta Limón lata 330 ml", 2.2, "Bebidas Sin Alcohol", "Refresco", []),
  item("alibaba-agua-reserva", "Agua reserva (500 ml)", 2, "Bebidas Sin Alcohol", "Agua mineral", []),
  item("alibaba-agua-200", "Agua (200 ml)", 1.7, "Bebidas Sin Alcohol", "Agua mineral", []),
  item("alibaba-amstel", "Cerveza Amstel (330 ml)", 1.8, "Bebidas Con Alcohol", "Cerveza", []),
] as const;
