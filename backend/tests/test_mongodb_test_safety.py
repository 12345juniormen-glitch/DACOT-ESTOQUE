import pytest

from test_mongodb_integration import _validate_test_database_configuration


def test_mongo_integration_requires_explicit_database_cleanup_confirmation():
    with pytest.raises(RuntimeError, match="create and drop isolated databases"):
        _validate_test_database_configuration("mongodb://test-host", None, None)


def test_mongo_integration_rejects_application_uri():
    with pytest.raises(RuntimeError, match="must not be the same URI"):
        _validate_test_database_configuration("mongodb://same-host", "mongodb://same-host", "YES")


def test_mongo_integration_accepts_distinct_uri_with_explicit_confirmation():
    _validate_test_database_configuration("mongodb://test-host", "mongodb://app-host", "YES")


def test_mongo_integration_requires_a_test_uri():
    with pytest.raises(RuntimeError, match="dedicated test MongoDB"):
        _validate_test_database_configuration(None, None, "YES")
