#!/usr/bin/env python3
import os
import sys


def _add_services_path():
    here = os.path.dirname(__file__)
    root = os.path.abspath(os.path.join(here, '..', '..'))
    services = os.path.join(root, 'services-py')
    sys.path.insert(0, services)


def assert_path(spec: dict, path: str):
    assert 'paths' in spec, 'OpenAPI spec missing paths'
    assert path in spec['paths'], f'Missing expected path: {path}'
    # basic check for 200 response
    path_item = spec['paths'][path]
    methods = list(path_item.keys())
    assert methods, f'No methods defined for {path}'
    for m in methods:
        if 'responses' in path_item[m]:
            assert '200' in path_item[m]['responses'], f'Missing 200 response for {path} {m}'


def main():
    _add_services_path()
    from safety_gate_service.main import app as safety_app
    from scribe_service.main import app as scribe_app

    safety_spec = safety_app.openapi()
    scribe_spec = scribe_app.openapi()

    assert_path(safety_spec, '/analyze')
    assert_path(scribe_spec, '/transcribe')
    assert_path(scribe_spec, '/draft')

    print('OpenAPI validation passed for safety_gate_service and scribe_service')


if __name__ == '__main__':
    main()

