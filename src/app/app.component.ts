import { Component } from '@angular/core';
import { PickerComponent } from './picker/picker.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [PickerComponent],
  template: '<app-picker />',
})
export class AppComponent {}
