import React from 'react';
import { View, ViewProps, requireNativeComponent, Platform, UIManager } from 'react-native';
import { matrixOf } from '../filters/filters';

type NativeProps = ViewProps & { matrix?: number[] | null };

const hasNative = Platform.OS === 'android' && !!UIManager.getViewManagerConfig?.('MfFilterView');
const Native = hasNative ? requireNativeComponent<NativeProps>('MfFilterView') : null;

/** Draws its children through a colour filter (see filters/filters.ts). */
export function FilterView({ filter, children, ...rest }: ViewProps & { filter?: string }) {
  const matrix = matrixOf(filter);
  if (!Native) return <View {...rest}>{children}</View>;
  return <Native {...rest} matrix={matrix} collapsable={false}>{children}</Native>;
}
