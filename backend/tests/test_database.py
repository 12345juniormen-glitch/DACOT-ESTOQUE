from app import database as database_module
from app.config import Settings


class IndexCollection:
    def __init__(self):
        self.created = []
        self.indexes = {}
        self.dropped = []

    def create_index(self, keys, **options):
        self.created.append((keys, options))
        normalized_keys = [(keys, 1)] if isinstance(keys, str) else keys
        name = options.get("name") or "_".join(f"{field}_{direction}" for field, direction in normalized_keys)
        self.indexes[name] = {"key": normalized_keys, **options}
        return name

    def index_information(self):
        return self.indexes

    def drop_index(self, name):
        self.dropped.append(name)
        del self.indexes[name]


class IndexDatabase:
    def __init__(self):
        self.collections = {}

    def __getattr__(self, name):
        return self.collections.setdefault(name, IndexCollection())


class IndexClient:
    def __init__(self, *_args, **_kwargs):
        self.database = IndexDatabase()

    def __getitem__(self, _name):
        return self.database

    def close(self):
        pass


def test_catalog_idempotency_indexes_are_unique_tenant_scoped_and_ignore_legacy_documents(monkeypatch):
    client = IndexClient()
    monkeypatch.setattr(database_module, "MongoClient", lambda *_args, **_kwargs: client)
    database = database_module.Database(Settings(_env_file=None))

    database.ensure_indexes()

    for name in ("ingredients", "suppliers"):
        indexes = client.database.collections[name].created
        idempotency_index = next(options for keys, options in indexes
            if keys == [("restaurant_id", database_module.ASCENDING),
                        ("idempotency_key", database_module.ASCENDING)])
        assert idempotency_index["unique"] is True
        assert idempotency_index["partialFilterExpression"] == {
            "idempotency_key": {"$type": "string"},
        }


def test_optional_unique_indexes_ignore_absent_values_in_compound_tenant_keys(monkeypatch):
    client = IndexClient()
    monkeypatch.setattr(database_module, "MongoClient", lambda *_args, **_kwargs: client)
    database = database_module.Database(Settings(_env_file=None))

    database.ensure_indexes()

    optional_indexes = {
        "movements": "idempotency_key",
        "purchases": "idempotency_key",
        "purchase_receipts": "idempotency_key",
        "counts": "create_key",
        "losses": "idempotency_key",
        "purchases:code": "code",
    }
    for collection_key, field in optional_indexes.items():
        collection_name = collection_key.split(":", 1)[0]
        indexes = client.database.collections[collection_name].created
        expected_fields = ["restaurant_id", "code"] if collection_key.endswith(":code") else [
            "restaurant_id", field,
        ]
        keys = next(keys for keys, _options in indexes
            if [name for name, _direction in keys] == expected_fields)
        options = next(options for index_keys, options in indexes if index_keys == keys)
        assert options["unique"] is True
        assert options["partialFilterExpression"] == {field: {"$type": "string"}}
        assert options.get("sparse") is not True


def test_legacy_sparse_purchase_code_index_is_replaced_with_partial_unique_index(monkeypatch):
    client = IndexClient()
    collection = client.database.purchases
    legacy_name = "restaurant_id_1_code_1"
    collection.indexes[legacy_name] = {
        "key": [("restaurant_id", 1), ("code", 1)], "unique": True, "sparse": True,
    }
    monkeypatch.setattr(database_module, "MongoClient", lambda *_args, **_kwargs: client)
    database = database_module.Database(Settings(_env_file=None))

    database.ensure_indexes()

    assert collection.dropped == [legacy_name]
    assert collection.indexes[legacy_name]["partialFilterExpression"] == {"code": {"$type": "string"}}


def test_purchase_indexes_support_tenant_scoped_status_and_supplier_pages(monkeypatch):
    client = IndexClient()
    monkeypatch.setattr(database_module, "MongoClient", lambda *_args, **_kwargs: client)
    database = database_module.Database(Settings(_env_file=None))

    database.ensure_indexes()

    indexes = client.database.collections["purchases"].created
    keys = [keys for keys, _options in indexes]
    assert [("restaurant_id", database_module.ASCENDING), ("status", database_module.ASCENDING),
        ("created_at", database_module.DESCENDING), ("_id", database_module.DESCENDING)] in keys
    assert [("restaurant_id", database_module.ASCENDING), ("supplier_id", database_module.ASCENDING),
        ("created_at", database_module.DESCENDING), ("_id", database_module.DESCENDING)] in keys
