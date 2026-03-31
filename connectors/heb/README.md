# H-E-B Connector

Exports your H-E-B account profile, order history, and product nutrition data.

## Scopes

| Scope | Description |
|-------|-------------|
| `heb.profile` | Name, email, phone, delivery addresses |
| `heb.orders` | Curbside and delivery orders with items, quantities, prices, dates |
| `heb.nutrition` | Nutrition facts per product (calories, macros, sodium, fiber, vitamins) |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `USDA_API_KEY` | No | `DEMO_KEY` | [USDA FoodData Central](https://fdc.nal.usda.gov/api-guide) API key for nutrition lookup. The demo key works but is rate-limited. Get a free key at https://fdc.nal.usda.gov/api-key-signup |

## How nutrition lookup works

1. Try the product's UPC barcode against USDA FDC (exact match)
2. If no UPC match, search by product name against Branded foods (top 5 results scored with `scoreMatch()`)
3. If branded results are poor, fall back to Foundation data type (for produce, staples, etc.)
4. HEB's own nutrition data is used when available; incomplete HEB data (null calories/macros) falls through to USDA while preserving HEB ingredients, allergens, and category
