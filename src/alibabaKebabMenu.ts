export const ALIBABA_KEBAB_COVER_IMAGE = "https://images.unsplash.com/photo-1561651823-34feb02250e4?auto=format&fit=crop&w=1280&q=80";

const drinkOptions = [
  { id: "coca-cola", name: "Coca-Cola lata 330 ml", price: 2.5 },
  { id: "coca-cola-zero", name: "Coca-Cola Zero lata 330 ml", price: 2.5 },
  { id: "fanta", name: "Fanta Naranja lata 330 ml", price: 2.5 },
  { id: "sprite", name: "Sprite lata 330 ml", price: 2.5 },
  { id: "aquarius", name: "Aquarius Limón lata 330 ml", price: 2.5 },
  { id: "agua", name: "Agua 33 cl", price: 2.5 },
];

const sauceOptions = [
  { id: "blanca", name: "Salsa blanca", price: 0 },
  { id: "picante", name: "Salsa picante", price: 0 },
  { id: "barbacoa", name: "Salsa barbacoa", price: 0 },
  { id: "sin-salsa", name: "Sin salsa", price: 0 },
];

const modifiers = [
  { id: "salsa", name: "Elige tu salsa", description: "Opcional · elige una", price: 0, required: false, minSelections: 0, maxSelections: 1, options: sauceOptions },
  { id: "extra", name: "¿Quieres añadir un extra?", description: "Opcional · elige uno", price: 0, required: false, minSelections: 0, maxSelections: 1, options: [
    { id: "gratinado", name: "Extra de gratinado", price: 1.9 },
    { id: "queso", name: "Extra de queso", price: 1.5 },
    { id: "carne", name: "Extra de carne", price: 2.5 },
  ] },
  { id: "bebida", name: "Añade una bebida", description: "Opcional · elige una", price: 0, required: false, minSelections: 0, maxSelections: 1, options: drinkOptions },
];

const item = (id: string, name: string, price: number, category: string, description: string, popular = false) => ({
  id, name, price, category, description, image: "", allergens: ["Gluten"], modifiers, available: true, vegetarian: false, popular,
});

export const alibabaKebabMenu = [
  item("alibaba-menu-10", "Menú 10", 10.5, "Menús", "Doner plato especial grande con ensalada, carne asada, patatas y bebida", true),
  item("alibaba-menu-1", "Menú 1", 9, "Menús", "Doner kebab, patatas fritas y bebida", true),
  item("alibaba-menu-5", "Menú 5 grande", 9, "Menús", "Patatas con carne y bebida", true),
  item("alibaba-doner-plato", "Doner plato especial grande", 8.5, "Platos", "Carne asada, ensalada y patatas fritas"),
  item("alibaba-doner-pan", "Doner kebab en pan", 6.5, "Kebab", "Pan tostado, carne asada, ensalada y salsa"),
  item("alibaba-durum", "Durum kebab", 7, "Kebab", "Tortilla enrollada con carne, ensalada y salsa"),
  item("alibaba-box", "Box kebab", 7.5, "Kebab", "Carne, patatas y salsa en formato box"),
  item("alibaba-patatas-carne", "Tapa de patatas con carne grande", 7, "Raciones", "Patatas fritas cubiertas con carne asada"),
  item("alibaba-patatas", "Patatas fritas", 3.5, "Raciones", "Ración de patatas fritas"),
  item("alibaba-falafel", "Falafel en pan", 6, "Vegetariano", "Falafel, ensalada y salsa"),
  item("alibaba-baklava", "Baklava", 3.5, "Postres", "Dulce tradicional"),
  item("alibaba-refresco", "Refresco lata 330 ml", 2.5, "Bebidas", "Elige tu refresco", true),
] as const;
