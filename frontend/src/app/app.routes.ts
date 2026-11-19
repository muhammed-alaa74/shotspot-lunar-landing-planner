import { Routes } from '@angular/router';
import { Home } from './pages/home/home';
import { About } from './pages/about/about';
import { Studio } from './pages/studio/studio';

export const routes: Routes = [
  { path: '', component: Home, title: 'SHOTSPOT — Plan for the miss' },
  { path: 'mission', component: Studio, title: 'SHOTSPOT — Mission Studio' },
  { path: 'demo', pathMatch: 'full', redirectTo: 'mission' },
  { path: 'planner', pathMatch: 'full', redirectTo: ({ fragment }) => `/mission?mode=explore${fragment ? '#' + encodeURIComponent(fragment) : ''}` },
  { path: 'about', component: About, title: 'SHOTSPOT — Sources & limits' },
  { path: 'plan/:section', redirectTo: ({ params }) => `/mission?mode=explore#${encodeURIComponent(params['section'])}` },
  { path: '**', redirectTo: '' },
];
