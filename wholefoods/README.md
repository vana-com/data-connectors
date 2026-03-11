# Whole Foods Market Connector

Exports your Whole Foods Market order history (via Amazon) and product nutrition data.

## Scopes

| Scope | Description |
|-------|-------------|
| `wholefoods.profile` | Amazon account name and email associated with Whole Foods orders |
| `wholefoods.orders` | Delivery and pickup orders with items, quantities, prices, dates |
| `wholefoods.nutrition` | Nutrition facts per product (calories, macros, sodium, fiber, vitamins) |

## How it works

Whole Foods orders are placed through Amazon. The connector:

1. Navigates to Amazon order history and detects login state
2. Filters orders to Whole Foods deliveries using Amazon's order filter
3. For each order, extracts items, prices, quantities, and order metadata
4. For each unique product, fetches nutrition from the Whole Foods product page
5. Falls back to USDA FoodData Central when store page nutrition is unavailable

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `USDA_API_KEY` | No | `DEMO_KEY` | [USDA FoodData Central](https://fdc.nal.usda.gov/api-guide) API key for nutrition fallback. The demo key works but is rate-limited. Get a free key at https://fdc.nal.usda.gov/api-key-signup |

## Data quirks

- **Ghost items**: Amazon sidebar recommendations sometimes appear in order item lists. These are filtered out by detecting `almBrandId` in the product URL.
- **Null calories**: Some store-scraped products have incomplete nutrition. When protein, carbs, and fat are available, calories are derived via Atwater factors (4·P + 4·C + 9·F).
- **Sugar coverage**: ~50% of Whole Foods items have null sugar data. The connector reports a `coverage` object so consumers can assess data completeness.
- **Image URLs**: ~77% of items lack image URLs from the product page. Consumers should use initials-based placeholders.
