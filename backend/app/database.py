from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import OperationFailure

from app.config import Settings


class MongoTransactionSupportError(RuntimeError):
    """Raised when MongoDB cannot provide multi-document transactions."""


def supports_transactions(hello: dict) -> bool:
    # MongoDB transactions require a replica set or a sharded cluster.
    return bool(hello.get("setName") or hello.get("msg") == "isdbgrid")


class Database:
    def __init__(self, settings: Settings):
        self.client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=3000)
        self.db = self.client[settings.mongodb_database]

    def check_transaction_support(self) -> None:
        hello = self.client.admin.command("hello")
        if not supports_transactions(hello):
            raise MongoTransactionSupportError(
                "MongoDB transactions require a replica set or sharded cluster"
            )

    @staticmethod
    def _ensure_optional_unique_index(collection, keys, optional_field: str) -> None:
        # A compound sparse index still includes legacy documents that contain
        # restaurant_id. Migrate the known index in place to a partial unique
        # index so absent/null idempotency keys and legacy codes are ignored.
        index_name = "_".join(f"{field}_{direction}" for field, direction in keys)
        expected_filter = {optional_field: {"$type": "string"}}
        existing = collection.index_information().get(index_name)
        if existing:
            existing_keys = [(field, direction) for field, direction in existing.get("key", [])]
            if existing_keys != keys:
                raise RuntimeError(f"Unexpected MongoDB index definition for {index_name}")
            if existing.get("unique") is True and existing.get("partialFilterExpression") == expected_filter:
                return
            try:
                collection.drop_index(index_name)
            except OperationFailure as exc:
                # Another API worker may already have dropped the legacy index
                # during a simultaneous startup migration.
                if exc.code != 27:  # IndexNotFound
                    raise
        collection.create_index(keys, unique=True, partialFilterExpression=expected_filter)

    def ensure_indexes(self) -> None:
        self.db.order_integrations.create_index([("restaurant_id", ASCENDING)], unique=True)
        self.db.order_integration_events.create_index(
            [("restaurant_id", ASCENDING), ("event_id", ASCENDING)], unique=True
        )
        self.db.order_integration_events.create_index(
            [("restaurant_id", ASCENDING), ("order_id", ASCENDING), ("order_revision", ASCENDING)]
        )
        self.db.order_integration_events.create_index(
            [("restaurant_id", ASCENDING), ("status", ASCENDING), ("processed_at", DESCENDING)]
        )
        self.db.order_integration_exceptions.create_index(
            [("restaurant_id", ASCENDING), ("event_id", ASCENDING)], unique=True
        )
        self.db.order_integration_exceptions.create_index(
            [("restaurant_id", ASCENDING), ("status", ASCENDING), ("processed_at", DESCENDING)]
        )
        self.db.inventory_order_state.create_index(
            [("restaurant_id", ASCENDING), ("order_id", ASCENDING)], unique=True
        )
        self.db.ingredients.create_index(
            [("restaurant_id", ASCENDING), ("name_normalized", ASCENDING)], unique=True
        )
        self._ensure_optional_unique_index(self.db.ingredients,
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], "idempotency_key")
        self.db.suppliers.create_index(
            [("restaurant_id", ASCENDING), ("name_normalized", ASCENDING)], unique=True
        )
        self._ensure_optional_unique_index(self.db.suppliers,
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], "idempotency_key")
        self._ensure_optional_unique_index(self.db.movements,
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], "idempotency_key")
        self.db.movements.create_index(
            [("restaurant_id", ASCENDING), ("ingredient_id", ASCENDING), ("occurred_at", ASCENDING)]
        )
        self.db.movements.create_index(
            [("restaurant_id", ASCENDING), ("audit_event_id", ASCENDING)], sparse=True
        )
        self.db.audit_events.create_index(
            [("restaurant_id", ASCENDING), ("at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.movements.create_index(
            [("restaurant_id", ASCENDING), ("occurred_at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.movements.create_index(
            [("restaurant_id", ASCENDING), ("kind", ASCENDING), ("occurred_at", DESCENDING)]
        )
        self.db.movements.create_index(
            [("restaurant_id", ASCENDING), ("reversal_of", ASCENDING)], sparse=True
        )
        self.db.losses.create_index(
            [("restaurant_id", ASCENDING), ("occurred_at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.recipes.create_index(
            [("restaurant_id", ASCENDING), ("product_id", ASCENDING)], unique=True
        )
        self.db.recipes.create_index(
            [("restaurant_id", ASCENDING), ("lines.ingredient_id", ASCENDING)]
        )
        self.db.recipes.create_index(
            [("restaurant_id", ASCENDING), ("product_name", ASCENDING), ("_id", ASCENDING)]
        )
        self.db.recipe_snapshots.create_index(
            [("restaurant_id", ASCENDING), ("product_id", ASCENDING), ("occurred_at", DESCENDING)]
        )
        self.db.recipe_snapshots.create_index(
            [("restaurant_id", ASCENDING), ("occurred_at", DESCENDING), ("_id", DESCENDING)]
        )
        self._ensure_optional_unique_index(self.db.purchases,
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], "idempotency_key")
        self.db.purchases.create_index(
            [("restaurant_id", ASCENDING), ("created_at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.purchases.create_index(
            [("restaurant_id", ASCENDING), ("status", ASCENDING),
             ("created_at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.purchases.create_index(
            [("restaurant_id", ASCENDING), ("supplier_id", ASCENDING),
             ("created_at", DESCENDING), ("_id", DESCENDING)]
        )
        self._ensure_optional_unique_index(self.db.purchases,
            [("restaurant_id", ASCENDING), ("code", ASCENDING)], "code")
        self._ensure_optional_unique_index(self.db.purchase_receipts,
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], "idempotency_key")
        self.db.purchase_receipts.create_index(
            [("restaurant_id", ASCENDING), ("purchase_id", ASCENDING), ("received_at", DESCENDING)]
        )
        self.db.purchase_receipts.create_index(
            [("restaurant_id", ASCENDING), ("received_at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.purchase_changes.create_index(
            [("restaurant_id", ASCENDING), ("purchase_id", ASCENDING), ("occurred_at", DESCENDING)]
        )
        self.db.purchase_changes.create_index(
            [("restaurant_id", ASCENDING), ("occurred_at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.auth_sessions.create_index(
            [("browser_binding_hash", ASCENDING), ("tab_session_id_hash", ASCENDING)], unique=True
        )
        self.db.auth_sessions.create_index("expires_at", expireAfterSeconds=0)
        self.db.consumed_handoffs.create_index("expires_at", expireAfterSeconds=0)
        self.db.counts.create_index(
            [("restaurant_id", ASCENDING), ("created_at", DESCENDING), ("_id", DESCENDING)]
        )
        self.db.counts.create_index(
            [("restaurant_id", ASCENDING), ("approved_at", DESCENDING), ("_id", DESCENDING)]
        )
        self._ensure_optional_unique_index(self.db.counts,
            [("restaurant_id", ASCENDING), ("create_key", ASCENDING)], "create_key")
        self._ensure_optional_unique_index(self.db.losses,
            [("restaurant_id", ASCENDING), ("idempotency_key", ASCENDING)], "idempotency_key")
        self.db.losses.create_index(
            [("restaurant_id", ASCENDING), ("occurred_at", DESCENDING)]
        )

    def close(self) -> None:
        self.client.close()
