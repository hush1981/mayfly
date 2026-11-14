import { createNavigationContainerRef } from '@react-navigation/native';
import { RootStackParamList } from '../types';

/** Lets code outside screens navigate (e.g. an incoming call). */
export const navRef = createNavigationContainerRef<RootStackParamList>();
