/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
import assert from '../../shared/assert';
import {
    isUndefined,
    forEach,
    defineProperty,
    getOwnPropertyDescriptor,
    isFunction,
    ArrayPush,
    toString,
    isFalse,
} from '../../shared/language';
import { ComponentConstructor } from '../component';
import { internalWireFieldDecorator } from './wire';
import { internalTrackDecorator } from './track';
import { createPublicPropertyDescriptor, createPublicAccessorDescriptor } from './api';
import {
    WireAdapterConstructor,
    storeWiredMethodMeta,
    storeWiredFieldMeta,
    ConfigCallback,
} from '../wiring';

// data produced by compiler
type WireCompilerMeta = Record<string, WireCompilerDef>;
type TrackCompilerMeta = Record<string, 1>;
type MethodCompilerMeta = string[];
type PropCompilerMeta = Record<string, PropCompilerDef>;
enum PropType {
    Field = 0,
    Set = 1,
    Get = 2,
    GetSet = 3,
}
interface PropCompilerDef {
    config: PropType; // 0 m
    type: string; // TODO: #1301 - make this an enum
}
interface WireCompilerDef {
    method?: number;
    adapter: WireAdapterConstructor;
    config: ConfigCallback;
}
interface RegisterDecoratorMeta {
    readonly publicMethods?: MethodCompilerMeta;
    readonly publicProps?: PropCompilerMeta;
    readonly track?: TrackCompilerMeta;
    readonly wire?: WireCompilerMeta;
    readonly fields?: string[];
}

function validateObservedField(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid field ${fieldName} declaration.`);
        }
    }
}

function validateFieldDecoratedWithTrack(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @track ${fieldName} declaration.`);
        }
    }
}

function validateFieldDecoratedWithWire(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @wire(...) ${fieldName} field declaration.`);
        }
    }
}

function validateMethodDecoratedWithWire(Ctor: ComponentConstructor, methodName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, methodName);
        if (
            isUndefined(descriptor) ||
            !isFunction(descriptor.value) ||
            isFalse(descriptor.writable)
        ) {
            assert.fail(`Compiler Error: Invalid @wire(...) ${methodName} method declaration.`);
        }
    }
}

function validateFieldDecoratedWithApi(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (!isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @api ${fieldName} field declaration.`);
        }
    }
}

function validateAccessorDecoratedWithApi(Ctor: ComponentConstructor, fieldName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, fieldName);
        if (isUndefined(descriptor)) {
            assert.fail(`Compiler Error: Invalid @api get ${fieldName} accessor declaration.`);
        } else if (isFunction(descriptor.set)) {
            assert.isTrue(
                isFunction(descriptor.get),
                `Compiler Error: Missing getter for property ${toString(
                    fieldName
                )} decorated with @api in ${Ctor}. You cannot have a setter without the corresponding getter.`
            );
        } else if (!isFunction(descriptor.get)) {
            assert.fail(`Compiler Error: Missing @api get ${fieldName} accessor declaration.`);
        }
    }
}

function validateMethodDecoratedWithApi(Ctor: ComponentConstructor, methodName: string) {
    if (process.env.NODE_ENV !== 'production') {
        const descriptor = getOwnPropertyDescriptor(Ctor.prototype, methodName);
        if (
            isUndefined(descriptor) ||
            !isFunction(descriptor.value) ||
            isFalse(descriptor.writable)
        ) {
            assert.fail(`Compiler Error: Invalid @api ${methodName} method declaration.`);
        }
    }
}

/**
 * INTERNAL: This function can only be invoked by compiled code. The compiler
 * will prevent this function from being imported by user-land code.
 */
export function registerDecorators(
    Ctor: ComponentConstructor,
    meta: RegisterDecoratorMeta
): ComponentConstructor {
    const proto = Ctor.prototype;
    const { publicProps, publicMethods, wire, track, fields } = meta;
    const apiMethods = [];
    const apiFields = [];
    const wiredMethods = [];
    const wiredFields = [];
    if (!isUndefined(publicProps)) {
        for (const fieldName in publicProps) {
            const propConfig = publicProps[fieldName];
            let descriptor: PropertyDescriptor | undefined;
            if (propConfig.config > 0) {
                // accessor declaration
                if (process.env.NODE_ENV !== 'production') {
                    validateAccessorDecoratedWithApi(Ctor, fieldName);
                }
                descriptor = getOwnPropertyDescriptor(proto, fieldName);
                descriptor = createPublicAccessorDescriptor(
                    fieldName,
                    descriptor as PropertyDescriptor
                );
            } else {
                // field declaration
                if (process.env.NODE_ENV !== 'production') {
                    validateFieldDecoratedWithApi(Ctor, fieldName);
                }
                descriptor = createPublicPropertyDescriptor(fieldName);
            }
            ArrayPush.call(apiFields, fieldName);
            defineProperty(proto, fieldName, descriptor);
        }
    }
    if (!isUndefined(publicMethods)) {
        forEach.call(publicMethods, methodName => {
            if (process.env.NODE_ENV !== 'production') {
                validateMethodDecoratedWithApi(Ctor, methodName);
            }
            ArrayPush.call(apiMethods, methodName);
        });
    }
    if (!isUndefined(wire)) {
        for (const fieldOrMethodName in wire) {
            const { adapter, method } = wire[fieldOrMethodName];
            const configCallback = wire[fieldOrMethodName].config;
            if (method === 1) {
                if (process.env.NODE_ENV !== 'production') {
                    validateMethodDecoratedWithWire(Ctor, fieldOrMethodName);
                }
                ArrayPush.call(wiredMethods, fieldOrMethodName);
                storeWiredMethodMeta(
                    Ctor,
                    fieldOrMethodName,
                    adapter,
                    proto[fieldOrMethodName] as (data: any) => void,
                    configCallback
                );
            } else {
                if (process.env.NODE_ENV !== 'production') {
                    validateFieldDecoratedWithWire(Ctor, fieldOrMethodName);
                }
                storeWiredFieldMeta(Ctor, fieldOrMethodName, adapter, configCallback);
                ArrayPush.call(wiredFields, fieldOrMethodName);
                defineProperty(
                    proto,
                    fieldOrMethodName,
                    internalWireFieldDecorator(fieldOrMethodName)
                );
            }
        }
    }
    if (!isUndefined(track)) {
        for (const fieldName in track) {
            if (process.env.NODE_ENV !== 'production') {
                validateFieldDecoratedWithTrack(Ctor, fieldName);
            }
            defineProperty(proto, fieldName, internalTrackDecorator(fieldName));
        }
    }
    if (!isUndefined(fields)) {
        for (let i = 0, n = fields.length; i < n; i++) {
            if (process.env.NODE_ENV !== 'production') {
                validateObservedField(Ctor, fields[i]);
            }
        }
    }
    setDecoratorsMeta(Ctor, {
        apiMethods,
        apiFields,
        wiredMethods,
        wiredFields,
        fields,
    });
    return Ctor;
}

const signedDecoratorToMetaMap: Map<ComponentConstructor, DecoratorMeta> = new Map();

interface DecoratorMeta {
    readonly apiMethods: string[];
    readonly apiFields: string[];
    readonly wiredMethods: string[];
    readonly wiredFields: string[];
    readonly fields?: string[];
}

function setDecoratorsMeta(Ctor: ComponentConstructor, meta: DecoratorMeta) {
    signedDecoratorToMetaMap.set(Ctor, meta);
}

const defaultMeta: DecoratorMeta = {
    apiMethods: [],
    apiFields: [],
    wiredMethods: [],
    wiredFields: [],
};

export function getDecoratorsMeta(Ctor: ComponentConstructor): DecoratorMeta {
    const meta = signedDecoratorToMetaMap.get(Ctor);
    return isUndefined(meta) ? defaultMeta : meta;
}
