import Swal from 'sweetalert2';

const baseToast = Swal.mixin({
  toast: true,
  position: 'top-end',
  showConfirmButton: false,
  timer: 2500,
  timerProgressBar: true
});

export function toastSuccess(message) {
  baseToast.fire({
    icon: 'success',
    title: message
  });
}

export function toastError(message) {
  baseToast.fire({
    icon: 'error',
    title: message
  });
}

export function toastInfo(message) {
  baseToast.fire({
    icon: 'info',
    title: message
  });
}

export function toastWarning(message) {
  baseToast.fire({
    icon: 'warning',
    title: message
  });
}

export function confirmAction({ title = 'Are you sure?', text = '', confirmButtonText = 'Yes', cancelButtonText = 'Cancel', icon = 'warning' } = {}) {
  return Swal.fire({
    title,
    text,
    icon,
    showCancelButton: true,
    confirmButtonColor: '#3085d6',
    cancelButtonColor: '#d33',
    confirmButtonText,
    cancelButtonText
  }).then(result => result.isConfirmed);
}

