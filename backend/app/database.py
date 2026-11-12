from pymongo import ASCENDING, MongoClient

from app.config import Settings


class Database:
    def __init__(self, settings: Settings):
        self.client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=3000)
        self.db = self.client[settings.mongodb_database]

    def ensure_indexes(self) -> None:
        self.db.ingredients.create_index(
            [("restaurant_id", ASCENDING), ("name_normalized", ASCENDING)], unique=True
        )
        self.db.suppliers.create_index(
            [("restaurant_id", ASCENDING), ("name_normalized", ASCENDING)], unique=True
        )
        self.db.movements.create_index(
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)],
            unique=True,
        )
        self.db.movements.create_index(
            [("restaurant_id", ASCENDING), ("ingredient_id", ASCENDING), ("occurred_at", ASCENDING)]
        )
        self.db.recipes.create_index(
            [("restaurant_id", ASCENDING), ("product_id", ASCENDING)], unique=True
        )
        self.db.purchases.create_index(
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], unique=True
        )
        self.db.purchases.create_index(
            [("restaurant_id", ASCENDING), ("code", ASCENDING)], unique=True, sparse=True
        )
        self.db.purchase_receipts.create_index(
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], unique=True
        )
        self.db.auth_sessions.create_index(
            [("browser_binding_hash", ASCENDING), ("tab_session_id_hash", ASCENDING)], unique=True
        )
        self.db.auth_sessions.create_index("expires_at", expireAfterSeconds=0)
        self.db.consumed_handoffs.create_index("expires_at", expireAfterSeconds=0)

    def close(self) -> None:
        self.client.close()
