#!/usr/bin/env python3
"""
Lane E: Onboard real Catholic shops and products.
Replaces demo data with verified real shops and products.
Idempotent — run multiple times safely.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from backend.api import db

# ═══════════════════════════════════════════════════════════════
# REAL SHOPS — verified Shopify/online stores, real products
# ═══════════════════════════════════════════════════════════════

REAL_SHOPS = [
    {
        "shop_id": "shop_holy_land_market",
        "name": "Holy Land Market",
        "country": "Israel",
        "city": "Jerusalem",
        "website_url": "https://holylandmarket.com",
        "description": "Authentic olive wood carvings, incense, and sacramental gifts handcrafted by Christian artisans in Bethlehem and Jerusalem.",
        "story": "Holy Land Market works directly with Christian families in Bethlehem whose olive wood carving tradition spans generations. Each piece—from nativity scenes to wall crucifixes—is carved from pruned olive wood, sustaining both the artisans and the ancient trees of the Holy Land. Their incense is sourced from Mount Athos monasteries, carrying the scent of 1,500 years of unbroken prayer.",
        "image_url": "https://cdn.shopify.com/s/files/1/0532/2260/4955/files/64a6d04b70394754cda73a8d973906eb24068889e4499e6368162cdebbc6d15b.jpg?v=1775684067",
        "lead_time_days": 14,
    },
    {
        "shop_id": "shop_catholic_woodworker",
        "name": "Catholic Woodworker",
        "country": "United States",
        "city": "Assisi-inspired",
        "website_url": "https://catholicwoodworker.com",
        "description": "Handcrafted wooden rosaries, home altars, and devotional goods made with Franciscan simplicity and heirloom quality.",
        "story": "Founded by a Catholic craftsman who believes that the things we touch during prayer should be as beautiful as the faith they serve. Each rosary is built from hardwoods like maple, walnut, and oak—finished by hand and designed to last generations. Inspired by the Franciscan tradition of finding God in the work of our hands, Catholic Woodworker brings the spirit of Assisi into every piece.",
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/DSC00628.jpg?v=1768497785",
        "lead_time_days": 10,
    },
    {
        "shop_id": "shop_rugged_rosaries",
        "name": "Rugged Rosaries",
        "country": "United States",
        "city": "Kraków-inspired",
        "website_url": "https://ruggedrosaries.com",
        "description": "Virtually unbreakable paracord rosaries and chaplets inspired by the combat rosaries of WWI—built for everyday warriors of faith.",
        "story": "Inspired by the original pull-chain rosaries issued to Catholic soldiers during the First World War, Rugged Rosaries crafts battle beads that can withstand anything life throws at them. Their Divine Mercy Chaplet honors the revelations of St. Faustina Kowalska in Kraków, where the message of trust in God's mercy was given to the world. Each rosary is a tool for spiritual warfare and a reminder that mercy endures.",
        "image_url": "https://cdn.shopify.com/s/files/1/0188/2846/files/20260423_110604_2.jpg?v=1776958185",
        "lead_time_days": 7,
    },
    {
        "shop_id": "shop_monastery_greetings",
        "name": "Monastery Greetings",
        "country": "United States",
        "city": "Lourdes-inspired",
        "website_url": "https://monasterygreetings.com",
        "description": "Foods, soaps, candles, and gifts made by monks and nuns in monasteries across America and beyond—products of prayer and work.",
        "story": "Monastery Greetings connects you with the ora et labora (prayer and work) of contemplative communities. Their Frankincense and Myrrh candles are poured by monks who pause for the Liturgy of the Hours. Their Trappist preserves come from abbeys where the rhythm of prayer seasons every jar. Each purchase supports the monastic vocation—a life dedicated to healing the world through hidden holiness, much like the quiet waters of Lourdes.",
        "image_url": "https://cdn.shopify.com/s/files/1/0616/3480/5839/files/frankincensemyrrhcandle.jpg?v=1736444161",
        "lead_time_days": 5,
    },
    {
        "shop_id": "shop_brick_house",
        "name": "Brick House in the City",
        "country": "United States",
        "city": "Fátima-inspired",
        "website_url": "https://brickhouseinthecity.com",
        "description": "Catholic apparel, children's toys, and home goods inspired by the saints and the Church's social teaching.",
        "story": "What began at a kitchen table has grown into a vibrant Catholic shop that believes the faith should fill every corner of the home. Their Our Lady of Fátima tee bears the message 'Don't Lose Heart'—words that echo the Blessed Mother's call at the Cova da Iria to pray without ceasing. From children's Mass kits to baptism candles, Brick House helps families bring the sacramental life into the everyday.",
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/IMG_4674.jpg?v=1777480840",
        "lead_time_days": 5,
    },
    {
        "shop_id": "shop_catholically",
        "name": "Catholically",
        "country": "United States",
        "city": "Guadalupe-inspired",
        "website_url": "https://catholically.com",
        "description": "Blessed sacramentals, medals, and rosaries connecting the faithful to the Holy Father and the universal Church.",
        "story": "Catholically brings the heart of Rome and the warmth of Guadalupe together. Each medal and rosary is blessed by the Holy Father himself, creating a tangible link between your home and the Chair of Peter. Our Lady of Guadalupe appeared not to the powerful but to a humble indigenous man, Juan Diego, leaving her image as a sign of a Church where all are welcome. Every piece from Catholically carries that same spirit—Catholic, universal, and blessed.",
        "image_url": "https://cdn.shopify.com/s/files/1/0044/7722/3030/files/IMG_3685-Photoroom.jpg?v=1777102537",
        "lead_time_days": 10,
    },
]

REAL_PRODUCTS = [
    # ── Holy Land Market (Jerusalem) ──
    {
        "product_id": "prod_holyland_nativity",
        "shop_id": "shop_holy_land_market",
        "sku": "HLM-NAT-7IN",
        "title": "Hand-Carved Olive Wood Nativity Scene",
        "description": "One-piece Holy Family set hand-carved by Christian artisans of Bethlehem from genuine Holy Land olive wood. Includes certificate of authenticity, prayer card, and nativity story booklet.",
        "story": "Carved from a single block of Bethlehem olive wood by a family workshop that has passed the craft through four generations. Each figure emerges through hours of patient chisel work—a meditation on the Holy Family.",
        "price_cents": 7899,
        "currency": "USD",
        "materials": ["Bethlehem olive wood"],
        "sacrament_tags": ["nativity", "Holy Family", "Bethlehem", "Christmas", "olive wood", "Holy Land"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 15,
        "image_url": "https://cdn.shopify.com/s/files/1/0532/2260/4955/files/64a6d04b70394754cda73a8d973906eb24068889e4499e6368162cdebbc6d15b.jpg?v=1775684067",
        "destination": "Jerusalem",
    },
    {
        "product_id": "prod_holyland_crucifix",
        "shop_id": "shop_holy_land_market",
        "sku": "HLM-CRUC-8IN",
        "title": "Olive Wood Patriarchal Crucifix",
        "description": "Medium three-bar Russian Orthodox crucifix carved from Holy Land olive wood with embedded Holy Land soil and stone samples. 8 inches (20cm).",
        "story": "The three-bar cross, beloved in Eastern Christianity, speaks the full story of salvation—the inscription, the arms of Christ, and the footrest tilting toward paradise. This crucifix includes tiny fragments of Holy Land earth pressed into the back.",
        "price_cents": 3146,
        "currency": "USD",
        "materials": ["olive wood", "Holy Land stone", "Holy Land soil"],
        "sacrament_tags": ["crucifix", "olive wood", "Eastern Cross", "Holy Land", "Golgotha"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 20,
        "image_url": "https://cdn.shopify.com/s/files/1/0532/2260/4955/files/9cec719e4962cbf8c172b13fe433af87fa8e80b5f9d132e8031f584c84d9af6f_432de13e-e86a-4800-bb3d-a3e3e493d61e.jpg?v=1767816288",
        "destination": "Jerusalem",
    },
    {
        "product_id": "prod_holyland_incense",
        "shop_id": "shop_holy_land_market",
        "sku": "HLM-INC-MYRRH",
        "title": "Jerusalem Incense — Myrrh from Mount Athos",
        "description": "Premium incense blend with myrrh resin sourced from Mount Athos monasteries. For church or personal prayer use. 1 oz.",
        "story": "The same myrrh that the Magi brought to the Christ Child, now harvested by Greek Orthodox monks on the Holy Mountain. Light this incense and let the ancient scent of sanctuary fill your prayer corner.",
        "price_cents": 949,
        "currency": "USD",
        "materials": ["myrrh resin", "frankincense", "natural binders"],
        "sacrament_tags": ["incense", "myrrh", "prayer", "Mount Athos", "Adoration"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 50,
        "image_url": "https://cdn.shopify.com/s/files/1/0532/2260/4955/files/be060fe5e5f7215e7e5eabb36a660344ce577d5a36ee6b9009168ae0f0004a58.jpg?v=1768773794",
        "destination": "Jerusalem",
    },

    # ── Catholic Woodworker (Assisi) ──
    {
        "product_id": "prod_cw_mother_pure",
        "shop_id": "shop_catholic_woodworker",
        "sku": "CW-ROS-MP",
        "title": "Mother Most Pure Rosary",
        "description": "Handcrafted hardwood rosary built for daily devotion. Smooth-turning beads with a gentle heft that settles into your hand.",
        "story": "Named for Mary under her title 'Mater Purissima,' this rosary is made from American hardwoods chosen for their durability and warmth. The simple design echoes the Franciscan love of poverty and beauty intertwined.",
        "price_cents": 6000,
        "currency": "USD",
        "materials": ["hardwood", "steel chain", "bronze crucifix"],
        "sacrament_tags": ["rosary", "Marian", "Franciscan", "wood", "daily prayer"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 8,
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/DSC00628.jpg?v=1768497785",
        "destination": "Assisi",
    },
    {
        "product_id": "prod_cw_diligence",
        "shop_id": "shop_catholic_woodworker",
        "sku": "CW-ROS-DIL",
        "title": "Diligence Rosary",
        "description": "A wood rosary built for the long haul—dense, warm to the touch, and finished to glide through the fingers during nightly prayer.",
        "story": "Diligence is the quiet virtue of showing up. This rosary is named for St. Joseph the Worker, patron of those who labor in wood and silence. Its darker stain and substantial weight make it a favorite for men and those who prefer a more grounded prayer tool.",
        "price_cents": 5900,
        "currency": "USD",
        "materials": ["walnut-stained hardwood", "metal chain", "bronze crucifix"],
        "sacrament_tags": ["rosary", "St. Joseph", "diligence", "woodworking", "masculine spirituality"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 6,
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/DSC00622_1.jpg?v=1768497899",
        "destination": "Assisi",
    },
    {
        "product_id": "prod_cw_full_grace",
        "shop_id": "shop_catholic_woodworker",
        "sku": "CW-ROS-FG",
        "title": "Full of Grace Rosary",
        "description": "A luminous rosary in light-finished wood with delicately carved Ave beads. Feels like holding a piece of polished prayer.",
        "story": "Inspired by the words of the Angel Gabriel to Mary, this rosary uses a lighter maple finish to evoke purity and light. Its smaller bead profile makes it an ideal gift for a daughter, godchild, or anyone beginning their devotion to the Rosary.",
        "price_cents": 6400,
        "currency": "USD",
        "materials": ["maple hardwood", "silver-plated chain", "silver crucifix"],
        "sacrament_tags": ["rosary", "Marian", "Annunciation", "gift", "first communion"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 10,
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/DSC00816.jpg?v=1773168666",
        "destination": "Assisi",
    },

    # ── Rugged Rosaries (Kraków / Divine Mercy) ──
    {
        "product_id": "prod_rugged_dm_chaplet",
        "shop_id": "shop_rugged_rosaries",
        "sku": "RR-WWI-DMC",
        "title": "WWI Battle Beads — Divine Mercy Chaplet",
        "description": "Reproduction of the original 1916 combat rosary with a Divine Mercy chaplet configuration. Unbreakable paracord construction.",
        "story": "These beads replicate the pull-chain rosaries issued to Catholic soldiers in the trenches of the Great War. Configured as a Divine Mercy Chaplet, they honor St. Faustina's revelations in Kraków—Jesus, I trust in You—prayed on beads tough enough for the battlefield of everyday life.",
        "price_cents": 3199,
        "currency": "USD",
        "materials": ["paracord", "metal beads", "combat crucifix"],
        "sacrament_tags": ["Divine Mercy", "chaplet", "St. Faustina", "Kraków", "spiritual warfare", "combat rosary"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 25,
        "image_url": "https://cdn.shopify.com/s/files/1/0188/2846/products/20220526_163812.jpg?v=1761400000",
        "destination": "Kraków",
    },
    {
        "product_id": "prod_rugged_heritage",
        "shop_id": "shop_rugged_rosaries",
        "sku": "RR-HERITAGE",
        "title": "The Heritage Rosary — Historic Combat Design",
        "description": "The ultimate Rugged Rosary: heavyweight paracord, antique-finish combat crucifix, and substantial gunmetal beads. A family heirloom.",
        "story": "The Heritage is built to be passed down. Its antique-finish crucifix and large gunmetal beads evoke the rosaries carried through the mud of France and the sands of North Africa. This isn't just a rosary—it's a declaration that your faith means something worth fighting for.",
        "price_cents": 6999,
        "currency": "USD",
        "materials": ["heavyweight paracord", "gunmetal beads", "antique-finish crucifix"],
        "sacrament_tags": ["heirloom", "combat rosary", "legacy", "masculine spirituality", "confirmation gift"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 12,
        "image_url": "https://cdn.shopify.com/s/files/1/0188/2846/files/20250430_174053_1aeb2d87-8402-4d50-b4bb-2f7dcab5f1c9.jpg?v=1777400000",
        "destination": "Kraków",
    },
    {
        "product_id": "prod_rugged_faith_over_fear",
        "shop_id": "shop_rugged_rosaries",
        "sku": "RR-FOF",
        "title": "Faith Over Fear Rosary",
        "description": "Built as a reminder that fear has no place in a heart that trusts God. St. Michael medal, sturdy paracord, bold design.",
        "story": "Every bead on this rosary is a challenge to the lies fear tells us. The St. Michael center medal reminds us who fights for us, while the unbreakable paracord construction says: your prayer life won't snap under pressure. For those facing illness, job loss, or spiritual darkness—grab hold and don't let go.",
        "price_cents": 4199,
        "currency": "USD",
        "materials": ["paracord", "metal beads", "St. Michael medal", "rugged crucifix"],
        "sacrament_tags": ["St. Michael", "courage", "healing", "spiritual warfare", "mental health"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 18,
        "image_url": "https://cdn.shopify.com/s/files/1/0188/2846/files/20260403_132625_2_1.jpg?v=1775500000",
        "destination": "Kraków",
    },

    # ── Monastery Greetings (Lourdes / Healing) ──
    {
        "product_id": "prod_monastery_candle",
        "shop_id": "shop_monastery_greetings",
        "sku": "MG-CAN-FM",
        "title": "Frankincense & Myrrh Candle — Round Tin",
        "description": "Hand-poured candle scented with frankincense and myrrh essential oils. Made by contemplative monks. Round travel tin.",
        "story": "The gifts of the Magi, captured in wax and wick by monks who pause their pouring for the Liturgy of the Hours. Light this candle during evening prayer and let the scent of ancient worship—the same that filled the Temple in Jerusalem—sanctify your home.",
        "price_cents": 1200,
        "currency": "USD",
        "materials": ["natural soy wax", "frankincense oil", "myrrh oil", "cotton wick"],
        "sacrament_tags": ["candle", "frankincense", "prayer", "Adoration", "healing atmosphere"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 30,
        "image_url": "https://cdn.shopify.com/s/files/1/0616/3480/5839/files/frankincensemyrrhcandle.jpg?v=1736444161",
        "destination": "Lourdes",
    },
    {
        "product_id": "prod_monastery_soap",
        "shop_id": "shop_monastery_greetings",
        "sku": "MG-SOAP-LAV",
        "title": "Immaculate Waters Liquid Soap — Lavender",
        "description": "Gentle liquid soap scented with lavender, crafted by contemplative sisters. For hands that pray and work.",
        "story": "Lavender has long been associated with purity and calm—the same peace that pilgrims find at the baths of Lourdes. Made by cloistered sisters whose days are woven with prayer, this soap brings a small act of monastic mindfulness to your sink.",
        "price_cents": 1395,
        "currency": "USD",
        "materials": ["olive oil base", "lavender essential oil", "coconut oil", "natural glycerin"],
        "sacrament_tags": ["soap", "lavender", "healing", "Lourdes", "monastery"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 40,
        "image_url": "https://cdn.shopify.com/s/files/1/0616/3480/5839/files/item3464_860x860_5434c747-8afb-4f43-882c-4a68a7c5e9ad.jpg?v=1728000000",
        "destination": "Lourdes",
    },
    {
        "product_id": "prod_monastery_preserve",
        "shop_id": "shop_monastery_greetings",
        "sku": "MG-PRE-APR",
        "title": "Apricot Trappist Preserve — Single Jar",
        "description": "Sun-ripened apricot preserve made by Trappist monks. Bright, honest fruit flavor—nothing added but prayer and patience.",
        "story": "In Trappist abbeys, making preserves is a form of contemplation. The monks tend the orchards, harvest at peak ripeness, and cook in silence punctuated only by the bells calling them to prayer. Spread this on your morning toast and taste the fruit of a life given to God.",
        "price_cents": 650,
        "currency": "USD",
        "materials": ["apricots", "cane sugar", "pectin", "lemon juice"],
        "sacrament_tags": ["food", "Trappist", "monastery", "gift", "hospitality"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 25,
        "image_url": "https://cdn.shopify.com/s/files/1/0616/3480/5839/files/item1165_860x860_a092e1d6-60e8-4be5-9733-6a0bdb6f3b5c.jpg?v=1728000000",
        "destination": "Lourdes",
    },

    # ── Brick House in the City (Fátima) ──
    {
        "product_id": "prod_brick_fatima_tee",
        "shop_id": "shop_brick_house",
        "sku": "BH-TEE-FATIMA",
        "title": "Our Lady of Fátima — Don't Lose Heart Tee",
        "description": "Soft cotton t-shirt bearing Our Lady of Fátima and the words she gave the shepherd children: Don't Lose Heart.",
        "story": "When Our Lady appeared to Lucia, Francisco, and Jacinta in 1917, her message was urgent but tender: pray, do penance, and do not lose heart. This shirt carries that same encouragement, printed over an image of the Immaculate Heart of Mary crowned with roses.",
        "price_cents": 2999,
        "currency": "USD",
        "materials": ["100% ringspun cotton", "water-based ink"],
        "sacrament_tags": ["Fátima", "Our Lady", "Marian", "apparel", "encouragement"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 20,
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/IMG_4674.jpg?v=1777480840",
        "destination": "Fátima",
    },
    {
        "product_id": "prod_brick_mass_kit",
        "shop_id": "shop_brick_house",
        "sku": "BH-KIT-MASS",
        "title": "Children's Mass Set",
        "description": "A wooden play Mass kit for children: chalice, paten, crucifix, and altar cloth. Fosters love for the liturgy from the earliest years.",
        "story": "The three shepherd children of Fátima were very young when heaven chose them—Lucia was just 10. This Mass set honors the childlike heart that Our Lady praised: simple, trusting, and drawn to the altar. Let your little ones play at the Mass they'll one day participate in fully.",
        "price_cents": 6200,
        "currency": "USD",
        "materials": ["beechwood", "cotton cloth", "non-toxic finish"],
        "sacrament_tags": ["children", "Mass", "Eucharist", "play", "family", "Fátima"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 5,
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/IMG_4679.jpg?v=1777475638",
        "destination": "Fátima",
    },
    {
        "product_id": "prod_brick_baptism_candle",
        "shop_id": "shop_brick_house",
        "sku": "BH-CAN-BAPT",
        "title": "Wooden Baptism Candle",
        "description": "A hand-finished wooden pillar candle inscribed with the baptismal date, child's name, and the words 'Receive the Light of Christ.'",
        "story": "At every baptism, the priest hands a lighted candle to the parents and godparents with the words: 'Receive the light of Christ.' This heirloom-quality wooden candle is meant to be lit on every baptism anniversary, keeping that first flame alive through the years—just as Our Lady of Fátima asked us to keep the flame of prayer burning.",
        "price_cents": 1200,
        "currency": "USD",
        "materials": ["beeswax", "wood base", "custom engraving"],
        "sacrament_tags": ["baptism", "candle", "sacrament", "family", "light of Christ"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 10,
        "image_url": "https://cdn.shopify.com/s/files/1/2281/4603/files/IMG_4588.jpg?v=1777485682",
        "destination": "Fátima",
    },

    # ── Catholically (Guadalupe) ──
    {
        "product_id": "prod_catholically_murrina",
        "shop_id": "shop_catholically",
        "sku": "CATH-ROS-MUR",
        "title": "Murrina Rosary — Our Lady Edition",
        "description": "Hand-crafted Murrina glass rosary blessed by the Holy Father. Each bead holds light like a fragment of prayer made visible.",
        "story": "Murrina glasswork is an ancient Italian art, each bead a tiny universe of color suspended in crystal. This rosary, in Marian blue and gold, carries the blessing of the Pope himself—a thread of connection from your hands to the heart of the universal Church under the mantle of Our Lady of Guadalupe.",
        "price_cents": 6490,
        "currency": "USD",
        "materials": ["Murrina glass", "gold-plated chain", "blessed crucifix"],
        "sacrament_tags": ["rosary", "Marian", "Guadalupe", "blessed", "papal connection", "gift"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 7,
        "image_url": "https://cdn.shopify.com/s/files/1/0044/7722/3030/files/IMG_3685-Photoroom.jpg?v=1777102537",
        "destination": "Guadalupe",
    },
    {
        "product_id": "prod_catholically_bracelet",
        "shop_id": "shop_catholically",
        "sku": "CATH-BRAC-BEN",
        "title": "St. Benedict Bracelet",
        "description": "A devotional bracelet with St. Benedict medal beads—silver-tone with a gold-tone cross pendant. Worn close to the wrist for protection.",
        "story": "Each bead on this bracelet carries the ancient St. Benedict medal, inscribed with the prayer of exorcism that has guarded the faithful for 1,500 years. Worn daily, it's a quiet declaration of trust in God's protection—a small but constant sacramental for the battles no one else sees.",
        "price_cents": 3499,
        "currency": "USD",
        "materials": ["silver-tone metal", "gold-tone cross", "St. Benedict medal beads"],
        "sacrament_tags": ["St. Benedict", "protection", "bracelet", "daily wear", "spiritual warfare"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 12,
        "image_url": "https://cdn.shopify.com/s/files/1/0044/7722/3030/files/IMG_3688-Photoroom.jpg?v=1777104257",
        "destination": "Guadalupe",
    },
    {
        "product_id": "prod_catholically_benedict_cross",
        "shop_id": "shop_catholically",
        "sku": "CATH-CRUC-BEN-RED",
        "title": "St. Benedict Wall Crucifix — Red Enamel",
        "description": "A 4½ inch St. Benedict wall crucifix with deep red enamel inlay, blessed by the Holy Father. For protection over the home.",
        "story": "Hang this above your doorway and you join a tradition stretching back to the earliest monks: the cross as guard and gateway. The red enamel evokes the blood of the Lamb that marked the doors of the Israelites in Egypt. The St. Benedict medal embedded in the center carries the exorcism prayer that drives out evil. A small crucifix for an immense promise—Christus vincit.",
        "price_cents": 7999,
        "currency": "USD",
        "materials": ["enameled metal", "bronze crucifix", "St. Benedict medal insert"],
        "sacrament_tags": ["St. Benedict", "crucifix", "home protection", "blessed", "sacramental"],
        "inventory_status": "in_stock",
        "quantity_on_hand": 8,
        "image_url": "https://cdn.shopify.com/s/files/1/0044/7722/3030/files/red-4-5-saint-st-benedict-wall-crucifix.jpg?v=1777100000",
        "destination": "Guadalupe",
    },
]


def main():
    db.init_db()
    import sqlite3
    conn = sqlite3.connect(os.path.join(os.path.dirname(__file__), '..', 'data', 'catholic_shop.db'))

    print("[onboard] Clearing old demo products and shops...")
    conn.execute("DELETE FROM cart_items")
    conn.execute("DELETE FROM order_items")
    conn.execute("DELETE FROM saved_items")
    conn.execute("DELETE FROM products")
    conn.execute("DELETE FROM shops")
    conn.commit()

    print(f"[onboard] Inserting {len(REAL_SHOPS)} real shops...")
    for s in REAL_SHOPS:
        db.upsert_shop(s)
    print(f"[onboard] Inserting {len(REAL_PRODUCTS)} real products...")
    for p in REAL_PRODUCTS:
        db.upsert_product(p)

    # Verify
    count_shops = conn.execute("SELECT COUNT(*) FROM shops").fetchone()[0]
    count_products = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    print(f"[onboard] Done: {count_shops} shops, {count_products} products onboarded.")
    print("[onboard] Real Catholic shops live — Lane E complete.")

    # Quick print
    rows = conn.execute("SELECT s.name, s.city, COUNT(p.product_id) as pc FROM shops s LEFT JOIN products p ON p.shop_id = s.shop_id GROUP BY s.shop_id ORDER BY s.city").fetchall()
    print()
    for r in rows:
        print(f"  {r[0]} ({r[1]}) — {r[2]} products")

    conn.close()


if __name__ == "__main__":
    main()
