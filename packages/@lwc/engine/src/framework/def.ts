/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
/**
 * This module is responsible for producing the ComponentDef object that is always
 * accessible via `vm.def`. This is lazily created during the creation of the first
 * instance of a component class, and shared across all instances.
 *
 * This structure can be used to synthetically create proxies, and understand the
 * shape of a component. It is also used internally to apply extra optimizations.
 */

import assert from '../shared/assert';
import {
    freeze,
    getOwnPropertyNames,
    getPrototypeOf,
    isNull,
    setPrototypeOf,
    isUndefined,
    isFunction,
    ArrayConcat,
    defineProperties,
} from '../shared/language';
import { createObservedFieldsDescriptorMap } from './observed-fields';
import {
    resolveCircularModuleDependency,
    isCircularModuleDependency,
    ViewModelReflection,
} from './utils';
import {
    ComponentConstructor,
    ErrorCallback,
    ComponentMeta,
    getComponentRegisteredMeta,
} from './component';
import { Template } from './template';

export interface ComponentDef {
    name: string;
    props: string[];
    wire: string[];
    template: Template;
    ctor: ComponentConstructor;
    bridge: HTMLElementConstructor;
    connectedCallback?: () => void;
    disconnectedCallback?: () => void;
    renderedCallback?: () => void;
    errorCallback?: ErrorCallback;
    render: () => Template;
}

const CtorToDefMap: WeakMap<any, ComponentDef> = new WeakMap();

function getCtorProto(Ctor: any, subclassComponentName: string): ComponentConstructor {
    let proto: ComponentConstructor | null = getPrototypeOf(Ctor);
    if (isNull(proto)) {
        throw new ReferenceError(
            `Invalid prototype chain for ${subclassComponentName}, you must extend LightningElement.`
        );
    }
    // covering the cases where the ref is circular in AMD
    if (isCircularModuleDependency(proto)) {
        const p = resolveCircularModuleDependency(proto);
        if (process.env.NODE_ENV !== 'production') {
            if (isNull(p)) {
                throw new ReferenceError(
                    `Circular module dependency for ${subclassComponentName}, must resolve to a constructor that extends LightningElement.`
                );
            }
        }
        // escape hatch for Locker and other abstractions to provide their own base class instead
        // of our Base class without having to leak it to user-land. If the circular function returns
        // itself, that's the signal that we have hit the end of the proto chain, which must always
        // be base.
        proto = p === proto ? BaseLightningElement : p;
    }
    return proto as ComponentConstructor;
}

function createComponentDef(
    Ctor: ComponentConstructor,
    meta: ComponentMeta,
    subclassComponentName: string
): ComponentDef {
    if (process.env.NODE_ENV !== 'production') {
        // local to dev block
        const ctorName = Ctor.name;
        // Removing the following assert until https://bugs.webkit.org/show_bug.cgi?id=190140 is fixed.
        // assert.isTrue(ctorName && isString(ctorName), `${toString(Ctor)} should have a "name" property with string value, but found ${ctorName}.`);
        assert.isTrue(
            Ctor.constructor,
            `Missing ${ctorName}.constructor, ${ctorName} should have a "constructor" property.`
        );
    }

    const { name } = meta;
    let { template } = meta;
    const decoratorsMeta = getDecoratorsMeta(Ctor);
    const { apiFields, apiMethods, wiredFields, wiredMethods, fields } = decoratorsMeta;
    const proto = Ctor.prototype;

    let {
        connectedCallback,
        disconnectedCallback,
        renderedCallback,
        errorCallback,
        render,
    } = proto;
    const superProto = getCtorProto(Ctor, subclassComponentName);
    const superDef: ComponentDef | null =
        (superProto as any) !== BaseLightningElement
            ? getComponentDef(superProto, subclassComponentName)
            : lightingElementDef;
    const SuperBridge = isNull(superDef) ? BaseBridgeElement : superDef.bridge;
    const bridge = HTMLBridgeElementFactory(SuperBridge, apiFields, apiMethods);
    const props = ArrayConcat.call(superDef.props, apiFields);
    const wire = ArrayConcat.call(superDef.wire, wiredFields, wiredMethods);
    connectedCallback = connectedCallback || superDef.connectedCallback;
    disconnectedCallback = disconnectedCallback || superDef.disconnectedCallback;
    renderedCallback = renderedCallback || superDef.renderedCallback;
    errorCallback = errorCallback || superDef.errorCallback;
    render = render || superDef.render;
    template = template || superDef.template;

    if (!isUndefined(fields)) {
        defineProperties(proto, createObservedFieldsDescriptorMap(fields));
    }

    const def: ComponentDef = {
        ctor: Ctor,
        name,
        wire,
        props,
        bridge,
        template,
        connectedCallback,
        disconnectedCallback,
        renderedCallback,
        errorCallback,
        render,
    };

    if (process.env.NODE_ENV !== 'production') {
        freeze(Ctor.prototype);
    }
    return def;
}

/**
 * EXPERIMENTAL: This function allows for the identification of LWC
 * constructors. This API is subject to change or being removed.
 */
export function isComponentConstructor(ctor: any): ctor is ComponentConstructor {
    if (!isFunction(ctor)) {
        return false;
    }

    // Fast path: LightningElement is part of the prototype chain of the constructor.
    if (ctor.prototype instanceof BaseLightningElement) {
        return true;
    }

    // Slow path: LightningElement is not part of the prototype chain of the constructor, we need
    // climb up the constructor prototype chain to check in case there are circular dependencies
    // to resolve.
    let current = ctor;
    do {
        if (isCircularModuleDependency(current)) {
            const circularResolved = resolveCircularModuleDependency(current);

            // If the circular function returns itself, that's the signal that we have hit the end of the proto chain,
            // which must always be a valid base constructor.
            if (circularResolved === current) {
                return true;
            }

            current = circularResolved;
        }

        if (current === BaseLightningElement) {
            return true;
        }
    } while (!isNull(current) && (current = getPrototypeOf(current)));

    // Finally return false if the LightningElement is not part of the prototype chain.
    return false;
}

/**
 * EXPERIMENTAL: This function allows for the collection of internal
 * component metadata. This API is subject to change or being removed.
 */
export function getComponentDef(Ctor: any, subclassComponentName?: string): ComponentDef {
    let def = CtorToDefMap.get(Ctor);

    if (isUndefined(def)) {
        if (!isComponentConstructor(Ctor)) {
            throw new TypeError(
                `${Ctor} is not a valid component, or does not extends LightningElement from "lwc". You probably forgot to add the extend clause on the class declaration.`
            );
        }

        let meta = getComponentRegisteredMeta(Ctor);
        if (isUndefined(meta)) {
            // TODO: #1295 - remove this workaround after refactoring tests
            meta = {
                template: undefined,
                name: Ctor.name,
            };
        }

        def = createComponentDef(Ctor, meta, subclassComponentName || Ctor.name);
        CtorToDefMap.set(Ctor, def);
    }

    return def;
}

/**
 * EXPERIMENTAL: This function provides access to the component constructor,
 * given an HTMLElement. This API is subject to change or being removed.
 */
export function getComponentConstructor(elm: HTMLElement): ComponentConstructor | null {
    let ctor: ComponentConstructor | null = null;
    if (elm instanceof HTMLElement) {
        const vm = getHiddenField(elm, ViewModelReflection);
        if (!isUndefined(vm)) {
            ctor = vm.def.ctor;
        }
    }
    return ctor;
}

// Only set prototype for public methods and properties
// No DOM Patching occurs here
export function setElementProto(elm: HTMLElement, def: ComponentDef) {
    setPrototypeOf(elm, def.bridge.prototype);
}

import { HTMLElementOriginalDescriptors } from './html-properties';
import { BaseLightningElement } from './base-lightning-element';
import {
    BaseBridgeElement,
    HTMLBridgeElementFactory,
    HTMLElementConstructor,
} from './base-bridge-element';
import { getDecoratorsMeta } from './decorators/register';
import { defaultEmptyTemplate } from './secure-template';
import { getHiddenField } from '../shared/fields';

const lightingElementDef: ComponentDef = {
    ctor: BaseLightningElement,
    name: BaseLightningElement.name,
    props: getOwnPropertyNames(HTMLElementOriginalDescriptors),
    wire: [],
    bridge: BaseBridgeElement,
    template: defaultEmptyTemplate,
    render: BaseLightningElement.prototype.render,
};
