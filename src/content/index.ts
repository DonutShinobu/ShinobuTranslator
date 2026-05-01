import { mountContentApp } from './App';
import { shinobuBake } from '../pipeline/bake';

(window as any).__shinobu_bake__ = shinobuBake;

mountContentApp();
