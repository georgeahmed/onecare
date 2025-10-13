#!/usr/bin/env python3
import os
import sys
from typing import Iterable, Mapping, Optional


def _add_services_path():
    here = os.path.dirname(__file__)
    root = os.path.abspath(os.path.join(here, '..', '..'))
    services = os.path.join(root, 'services-py')
    sys.path.insert(0, services)


def _assert_operation(
    spec: Mapping[str, object],
    path: str,
    method: str,
    *,
    request_ref: Optional[str] = None,
    response_ref: Optional[str] = None,
) -> Mapping[str, object]:
    paths = spec.get('paths')
    assert isinstance(paths, dict), 'OpenAPI spec missing paths'
    assert path in paths, f'Missing expected path: {path}'
    path_item = paths[path]
    assert isinstance(path_item, dict), f'Path item for {path} must be an object'
    assert method in path_item, f'Missing {method.upper()} operation for {path}'
    operation = path_item[method]
    assert isinstance(operation, dict), f'Operation {method} on {path} must be an object'

    responses = operation.get('responses')
    assert isinstance(responses, dict), f'Missing responses object for {path} {method}'
    assert '200' in responses, f'Missing 200 response for {path} {method}'
    if response_ref:
        ref = (
            responses.get('200', {})
            .get('content', {})
            .get('application/json', {})
            .get('schema', {})
            .get('$ref')
        )
        assert ref == response_ref, f'Unexpected 200 response schema for {path} {method}: {ref}'

    if request_ref:
        request_body = operation.get('requestBody')
        assert isinstance(request_body, dict), f'Missing requestBody for {path} {method}'
        ref = (
            request_body.get('content', {})
            .get('application/json', {})
            .get('schema', {})
            .get('$ref')
        )
        assert ref == request_ref, f'Unexpected request schema for {path} {method}: {ref}'

    return operation


def _assert_schema(
    spec: Mapping[str, object],
    name: str,
    *,
    required_fields: Iterable[str],
    properties: Iterable[str],
) -> Mapping[str, object]:
    components = spec.get('components', {})
    assert isinstance(components, dict), 'OpenAPI spec missing components'
    schemas = components.get('schemas', {})
    assert isinstance(schemas, dict), 'OpenAPI spec missing components.schemas'
    assert name in schemas, f'Missing schema: {name}'

    schema = schemas[name]
    assert isinstance(schema, dict), f'Schema {name} must be an object'
    props = schema.get('properties')
    assert isinstance(props, dict), f'Schema {name} missing properties'
    required = set(schema.get('required', []))

    for field in required_fields:
        assert field in required, f'{name} missing required field: {field}'
    for field in properties:
        assert field in props, f'{name} missing property: {field}'

    return schema


def _assert_enum(schema: Mapping[str, object], field: str, expected: Iterable[str]) -> None:
    props = schema.get('properties', {})
    assert isinstance(props, dict), 'Schema missing properties for enum assertion'
    prop = props.get(field)
    assert isinstance(prop, dict), f'Schema missing property {field} for enum assertion'
    enum_values = prop.get('enum')
    assert enum_values, f'Enum not defined for field {field}'
    assert set(enum_values) == set(expected), f'Unexpected enum for {field}: {enum_values}'


def main():
    _add_services_path()
    from safety_gate_service.main import app as safety_app
    from scribe_service.main import app as scribe_app

    safety_spec = safety_app.openapi()
    scribe_spec = scribe_app.openapi()

    _assert_operation(
        safety_spec,
        '/analyze',
        'post',
        request_ref='#/components/schemas/PortalSubmission',
        response_ref='#/components/schemas/SafetyDecision',
    )
    _assert_operation(
        safety_spec,
        '/predict',
        'post',
        request_ref='#/components/schemas/PredictRequest',
        response_ref='#/components/schemas/PredictResponse',
    )
    _assert_operation(
        safety_spec,
        '/predict_proba',
        'post',
        request_ref='#/components/schemas/PredictRequest',
        response_ref='#/components/schemas/PredictProbaResponse',
    )

    portal_schema = _assert_schema(
        safety_spec,
        'PortalSubmission',
        required_fields=('practiceId', 'patient', 'narrative', 'channel'),
        properties=('practiceId', 'patient', 'narrative', 'channel'),
    )
    _assert_enum(portal_schema, 'channel', ('web', 'ivr'))

    _assert_schema(
        safety_spec,
        'PortalSubmissionPatient',
        required_fields=('id',),
        properties=('id',),
    )
    safety_decision = _assert_schema(
        safety_spec,
        'SafetyDecision',
        required_fields=('outcome',),
        properties=('outcome',),
    )
    _assert_enum(safety_decision, 'outcome', ('DIVERTED', 'SAFE_TO_CONTINUE'))

    _assert_operation(
        scribe_spec,
        '/transcribe',
        'post',
        request_ref='#/components/schemas/ScribeAudio',
        response_ref='#/components/schemas/Transcript',
    )
    _assert_operation(
        scribe_spec,
        '/draft',
        'post',
        request_ref='#/components/schemas/Transcript',
        response_ref='#/components/schemas/Draft',
    )

    _assert_schema(
        scribe_spec,
        'ScribeAudio',
        required_fields=('encounterId', 'audioUrl', 'contentType'),
        properties=('encounterId', 'audioUrl', 'contentType'),
    )
    _assert_schema(
        scribe_spec,
        'Transcript',
        required_fields=('text',),
        properties=('text',),
    )
    _assert_schema(
        scribe_spec,
        'Draft',
        required_fields=('summary',),
        properties=('summary', 'approved'),
    )

    print('OpenAPI validation passed for safety_gate_service and scribe_service')


if __name__ == '__main__':
    main()
